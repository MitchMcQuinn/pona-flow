"""
Code resources — user-authored scripts executed by code-execution STEPs.

Purpose in the project
----------------------
A "Code execution" STEP stores its script as a *resource*: the code text lives in a
gitignored folder on disk (default ``<repo>/resources``, override with
``PONA_FLOW_RESOURCES_DIR``) and the catalog ``resources`` table maps a resource UID to
that file plus its name/description/language metadata. The STEP's entities payload
references only the UID (``{"kind": "code", "resource_id": ...}``), so the EXECUTION
package and run state never embed raw code.

Security model
--------------
- Resources are space-scoped: every lookup requires the space id to match, so one
  space can never load (or execute) another space's code.
- File paths are derived server-side from the resource id and normalized space id;
  client input never becomes a filesystem path (no traversal).
- The main app only *stores and loads* code. Execution happens in the separate
  sandbox runner service (``Engine/runner``) — never in this process.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from . import config, id_generator, spaces

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"
_RESOURCES_TABLE_SQL = _SCHEMA_DIR / "resources-table.sql"

# Supported sandbox languages and their on-disk file extensions.
LANGUAGE_EXTENSIONS = {"python": ".py", "javascript": ".js"}

# Cap stored code size: large blobs are a smell (and a disk-filling vector).
MAX_CODE_BYTES = 256 * 1024

_RESOURCE_ID_RE = re.compile(r"^ID_[A-Za-z0-9]+$")


def resources_dir() -> Path:
    """Root folder for resource code files (gitignored; never inside App/ or Engine/)."""
    raw = (os.environ.get("PONA_FLOW_RESOURCES_DIR") or "").strip()
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else config.ROOT / p
    return config.ROOT / "resources"


def normalize_language(raw: str) -> str:
    lang = (raw or "").strip().lower()
    if lang not in LANGUAGE_EXTENSIONS:
        raise ValueError(
            f"language must be one of {sorted(LANGUAGE_EXTENSIONS)} (got {raw!r})"
        )
    return lang


def validate_code(code: str) -> str:
    text = code if isinstance(code, str) else ""
    if not text.strip():
        raise ValueError("code is required")
    if len(text.encode("utf-8")) > MAX_CODE_BYTES:
        raise ValueError(f"code exceeds the {MAX_CODE_BYTES // 1024} KB limit")
    return text


def _validate_resource_id(resource_id: str) -> str:
    rid = (resource_id or "").strip()
    if not _RESOURCE_ID_RE.match(rid):
        raise ValueError("invalid resource id")
    return rid


def _relative_path(space_id: str, resource_id: str, language: str) -> str:
    """Server-derived storage path (relative to ``resources_dir``); never client input."""
    prefix = spaces.normalize_space_name(space_id)
    if not prefix:
        raise ValueError("space_id is required")
    ext = LANGUAGE_EXTENSIONS[language]
    return f"code/{prefix}/{resource_id}{ext}"


def _absolute_path(relative: str) -> Path:
    root = resources_dir().resolve()
    p = (root / relative).resolve()
    # Defense in depth: a stored path must stay inside the resources folder.
    if root != p and root not in p.parents:
        raise ValueError("resource path escapes the resources folder")
    return p


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _ensure_table(conn: sqlite3.Connection) -> None:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resources'"
    )
    if cur.fetchone() is None and _RESOURCES_TABLE_SQL.is_file():
        conn.executescript(_RESOURCES_TABLE_SQL.read_text(encoding="utf-8"))
        conn.commit()


def _row_to_metadata(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "space_id": row["space_id"],
        "name": row["name"],
        "description": row["description"] or "",
        "language": row["language"],
        "path": row["path"],
        "creation_date": row["creation_date"],
        "modified_date": row["modified_date"],
    }


def list_resources(space_id: str) -> list[dict[str, Any]]:
    """List a space's resources (metadata only; code is fetched per-resource)."""
    sid = (space_id or "").strip()
    conn = _conn()
    try:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT id, space_id, name, description, language, path, "
            "creation_date, modified_date FROM resources "
            "WHERE space_id = ? ORDER BY name ASC",
            (sid,),
        ).fetchall()
        return [_row_to_metadata(r) for r in rows]
    finally:
        conn.close()


def _fetch_row(conn: sqlite3.Connection, space_id: str, resource_id: str):
    return conn.execute(
        "SELECT id, space_id, name, description, language, path, "
        "creation_date, modified_date FROM resources WHERE id = ? AND space_id = ?",
        (resource_id, space_id),
    ).fetchone()


def get_resource(space_id: str, resource_id: str) -> dict[str, Any]:
    """Return a resource's metadata plus its code text (for the builder editor)."""
    sid = (space_id or "").strip()
    rid = _validate_resource_id(resource_id)
    conn = _conn()
    try:
        _ensure_table(conn)
        row = _fetch_row(conn, sid, rid)
    finally:
        conn.close()
    if row is None:
        raise KeyError(f"resource {rid!r} not found in space {sid!r}")
    out = _row_to_metadata(row)
    path = _absolute_path(row["path"])
    out["code"] = path.read_text(encoding="utf-8") if path.is_file() else ""
    return out


def upsert_resource(
    space_id: str,
    name: str,
    code: str,
    language: str,
    description: str | None = None,
    resource_id: str | None = None,
) -> dict[str, Any]:
    """
    Create or update a code resource: write the file and the catalog row.

    When ``resource_id`` is provided and exists in this space the resource is updated
    in place. A provided id that exists in ANOTHER space is rejected (cross-space
    protection); a provided id that exists nowhere creates the row with that id, which
    makes builder retries idempotent (the UI derives a stable id per STEP node).
    Returns metadata (without code).
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    display_name = (name or "").strip()
    if not display_name:
        raise ValueError("name is required")
    lang = normalize_language(language)
    text = validate_code(code)
    desc = (description or "").strip()

    conn = _conn()
    try:
        _ensure_table(conn)
        old_relative: str | None = None
        if resource_id:
            rid = _validate_resource_id(resource_id)
            existing = _fetch_row(conn, sid, rid)
            if existing is not None:
                old_relative = existing["path"]
            else:
                other = conn.execute(
                    "SELECT space_id FROM resources WHERE id = ?", (rid,)
                ).fetchone()
                if other is not None:
                    raise KeyError(f"resource {rid!r} not found in space {sid!r}")
        else:
            rid = id_generator.generate_id()

        relative = _relative_path(sid, rid, lang)
        absolute = _absolute_path(relative)
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_text(text, encoding="utf-8")
        # A language switch changes the extension; drop the stale file.
        if old_relative and old_relative != relative:
            try:
                _absolute_path(old_relative).unlink(missing_ok=True)
            except (OSError, ValueError):
                pass

        if old_relative is not None:
            conn.execute(
                "UPDATE resources SET name = ?, description = ?, language = ?, path = ?, "
                "modified_date = datetime('now') WHERE id = ? AND space_id = ?",
                (display_name, desc, lang, relative, rid, sid),
            )
        else:
            conn.execute(
                "INSERT INTO resources (id, space_id, name, description, language, path) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (rid, sid, display_name, desc, lang, relative),
            )
        conn.commit()
        row = _fetch_row(conn, sid, rid)
        return _row_to_metadata(row)
    finally:
        conn.close()


def delete_resource(space_id: str, resource_id: str) -> dict[str, Any]:
    """Delete a resource's file and catalog row (idempotent)."""
    sid = (space_id or "").strip()
    rid = _validate_resource_id(resource_id)
    conn = _conn()
    try:
        _ensure_table(conn)
        row = _fetch_row(conn, sid, rid)
        if row is not None:
            try:
                _absolute_path(row["path"]).unlink(missing_ok=True)
            except (OSError, ValueError):
                pass
            conn.execute(
                "DELETE FROM resources WHERE id = ? AND space_id = ?", (rid, sid)
            )
            conn.commit()
        return {"space_id": sid, "id": rid, "deleted": True}
    finally:
        conn.close()


def load_for_execution(space_id: str, resource_id: str) -> dict[str, Any]:
    """
    Load a resource for the executor: ``{id, name, language, code}``.

    Space-scoped (a step can never run another space's code) and raises a clear error
    when the row or file is missing so the run surfaces a useful step error.
    """
    resource = get_resource(space_id, resource_id)
    if not str(resource.get("code") or "").strip():
        raise KeyError(
            f"resource {resource_id!r} has no code file on disk "
            "(was the resources folder moved or cleaned?)"
        )
    return {
        "id": resource["id"],
        "name": resource["name"],
        "language": resource["language"],
        "code": resource["code"],
    }
