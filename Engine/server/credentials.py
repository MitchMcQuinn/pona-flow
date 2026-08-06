"""
Credential store — secure key/value secrets referenced by workflows.

Purpose in the project
----------------------
Spaces make outbound HTTP requests (endpoint STEPs) that need API keys / auth headers.
This module lets a space manager store those secrets and reference them from a workflow as
``$secret.<NAME>`` without ever exposing the value in the builder, catalog, run state, or
logs. It complements — and is deliberately separate from — agent API keys
(``agent_keys.py``), which are verify-only (SHA-256) and never need to be read back.

Design
------
- A pluggable :class:`CredentialStore` holds the *values*. Locally that is the project
  ``.env`` file (:class:`LocalEnvFileStore`); the default :class:`PassthroughStore` is
  read-only ``os.environ`` (today's behavior); a hosted provider adapter can be added later
  behind the same protocol. The active backend is chosen by
  ``config.credential_backend()`` (env var ``PONA_FLOW_CREDENTIAL_BACKEND``).
- The catalog ``space_credentials`` table holds *metadata only* (name, env key, description,
  backend, dates) — never the secret. This preserves the D6 env-key indirection used by the
  ``spaces`` table.
- Values resolve to a per-space, prefixed env key (``<SPACE_ID>_CRED_<NAME>``), so two spaces
  never collide and the key name is recognizable.
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Protocol

from . import config, id_generator, spaces

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"
_CREDENTIALS_TABLE_SQL = _SCHEMA_DIR / "space-credentials-table.sql"

# Credential names are identifier-shaped so they embed cleanly into the per-space env key
# and into a ``$secret.<NAME>`` reference (which must not look like a normal $param).
_CREDENTIAL_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# --------------------------------------------------------------------------------------
# Store backends
# --------------------------------------------------------------------------------------


class CredentialStore(Protocol):
    """A backend that holds credential *values* keyed by env-key name."""

    writable: bool

    def get(self, env_key: str) -> str | None: ...

    def set(self, env_key: str, value: str) -> None: ...

    def delete(self, env_key: str) -> None: ...

    def is_configured(self, env_key: str) -> bool: ...


class PassthroughStore:
    """Read-only ``os.environ`` view. The default; never writes the ``.env`` file.

    Used in production/passthrough mode where secrets are injected by the platform.
    Registration (metadata) is still allowed; only writing a value is rejected.
    """

    writable = False
    backend = "passthrough"

    def get(self, env_key: str) -> str | None:
        val = os.environ.get((env_key or "").strip())
        return val if val and str(val).strip() else None

    def set(self, env_key: str, value: str) -> None:
        raise PermissionError(
            "Credential store is read-only in this environment "
            "(PONA_FLOW_CREDENTIAL_BACKEND is not 'local'); inject the value via the "
            "hosting platform's secret store."
        )

    def delete(self, env_key: str) -> None:
        raise PermissionError(
            "Credential store is read-only in this environment; remove the value via the "
            "hosting platform's secret store."
        )

    def is_configured(self, env_key: str) -> bool:
        return self.get(env_key) is not None


class LocalEnvFileStore(PassthroughStore):
    """Read/write the project ``.env`` file (local development only)."""

    writable = True
    backend = "local"

    def set(self, env_key: str, value: str) -> None:
        config.set_env_value(env_key, value)

    def delete(self, env_key: str) -> None:
        config.delete_env_value(env_key)


def get_store() -> CredentialStore:
    """Return the credential store for the configured backend.

    ``hosted`` is treated as passthrough (read-only) until a provider adapter is added.
    """
    backend = config.credential_backend()
    if backend == "local":
        return LocalEnvFileStore()
    return PassthroughStore()


def active_backend() -> str:
    """Backend label for the UI (``local`` | ``passthrough`` | ``hosted``)."""
    return config.credential_backend()


# --------------------------------------------------------------------------------------
# Naming / references
# --------------------------------------------------------------------------------------


def normalize_credential_name(raw: str) -> str:
    """Identifier form of a credential name: upper, spaces -> ``_``, alnum/underscore only."""
    text = (raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", "_", text.upper())
    text = re.sub(r"[^A-Z0-9_]", "", text)
    text = re.sub(r"_+", "_", text).strip("_")
    if text and text[0].isdigit():
        text = f"_{text}"
    return text


def validate_credential_name(raw: str) -> str:
    """Normalize and validate a credential name, raising on an empty/invalid result."""
    name = normalize_credential_name(raw)
    if not name or not _CREDENTIAL_NAME_RE.match(name):
        raise ValueError(
            "Credential name must contain letters, numbers, or underscores "
            "(and may not start with a number)."
        )
    return name


def env_key_for(space_id: str, name: str) -> str:
    """Per-space env-key slot for a credential: ``<SPACE_ID>_CRED_<NAME>``."""
    prefix = spaces.normalize_space_name(space_id)
    norm = validate_credential_name(name)
    return f"{prefix}_CRED_{norm}"


# --------------------------------------------------------------------------------------
# Metadata CRUD (catalog space_credentials table)
# --------------------------------------------------------------------------------------


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _ensure_table(conn: sqlite3.Connection) -> None:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_credentials'"
    )
    if cur.fetchone() is None and _CREDENTIALS_TABLE_SQL.is_file():
        conn.executescript(_CREDENTIALS_TABLE_SQL.read_text(encoding="utf-8"))
        conn.commit()


def _row_to_metadata(row: sqlite3.Row, store: CredentialStore) -> dict[str, Any]:
    """Public metadata for a credential row. The value is NEVER included."""
    return {
        "id": row["id"],
        "space_id": row["space_id"],
        "name": row["name"],
        "env_key": row["env_key"],
        "description": row["description"] or "",
        "backend": row["backend"] or "local",
        "configured": store.is_configured(row["env_key"]),
        "creation_date": row["creation_date"],
        "modified_date": row["modified_date"],
    }


def list_credentials(space_id: str) -> list[dict[str, Any]]:
    """List a space's credentials (metadata + ``configured`` flag; never the value)."""
    sid = (space_id or "").strip()
    store = get_store()
    conn = _conn()
    try:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT id, space_id, name, env_key, description, backend, "
            "creation_date, modified_date FROM space_credentials "
            "WHERE space_id = ? ORDER BY name ASC",
            (sid,),
        ).fetchall()
        return [_row_to_metadata(r, store) for r in rows]
    finally:
        conn.close()


def upsert_credential(
    space_id: str,
    name: str,
    value: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """
    Register or update a credential for a space.

    When ``value`` is provided it is written to the store backend (requires a writable
    backend). When omitted/empty the row is registered without writing a value, so an
    operator can inject the secret out-of-band (hosted/passthrough mode). Returns metadata
    only — never the value.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    display_name = validate_credential_name(name)
    env_key = env_key_for(sid, display_name)
    store = get_store()
    desc = (description or "").strip()

    has_value = value is not None and str(value) != ""
    if has_value:
        # Raises PermissionError on a read-only backend (surfaced as a clear API error).
        store.set(env_key, str(value))

    conn = _conn()
    try:
        _ensure_table(conn)
        existing = conn.execute(
            "SELECT id FROM space_credentials WHERE space_id = ? AND name = ?",
            (sid, display_name),
        ).fetchone()
        if existing is not None:
            conn.execute(
                "UPDATE space_credentials SET env_key = ?, description = ?, backend = ?, "
                "modified_date = datetime('now') WHERE id = ?",
                (env_key, desc, store.backend, existing["id"]),
            )
            cred_id = existing["id"]
        else:
            cred_id = id_generator.generate_id()
            conn.execute(
                "INSERT INTO space_credentials "
                "(id, space_id, name, env_key, description, backend) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (cred_id, sid, display_name, env_key, desc, store.backend),
            )
        conn.commit()
        row = conn.execute(
            "SELECT id, space_id, name, env_key, description, backend, "
            "creation_date, modified_date FROM space_credentials WHERE id = ?",
            (cred_id,),
        ).fetchone()
        return _row_to_metadata(row, store)
    finally:
        conn.close()


def delete_credential(space_id: str, name: str) -> dict[str, Any]:
    """Delete a credential's value (from the store) and its metadata row (idempotent)."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    display_name = validate_credential_name(name)
    store = get_store()
    conn = _conn()
    try:
        _ensure_table(conn)
        row = conn.execute(
            "SELECT env_key FROM space_credentials WHERE space_id = ? AND name = ?",
            (sid, display_name),
        ).fetchone()
        if row is not None:
            if store.writable:
                store.delete(row["env_key"])
            conn.execute(
                "DELETE FROM space_credentials WHERE space_id = ? AND name = ?",
                (sid, display_name),
            )
            conn.commit()
        return {"space_id": sid, "name": display_name, "deleted": True}
    finally:
        conn.close()


def resolve(space_id: str, name: str) -> str | None:
    """
    Resolve a credential value for a ``$secret.<NAME>`` reference, or ``None`` if unknown.

    Only credentials registered for the space resolve (a typo cannot read an arbitrary env
    var). The returned value is the live secret — callers MUST NOT persist or log it.
    """
    sid = (space_id or "").strip()
    if not sid:
        return None
    try:
        display_name = validate_credential_name(name)
    except ValueError:
        return None
    store = get_store()
    conn = _conn()
    try:
        _ensure_table(conn)
        row = conn.execute(
            "SELECT env_key FROM space_credentials WHERE space_id = ? AND name = ?",
            (sid, display_name),
        ).fetchone()
        if row is None:
            return None
        return store.get(row["env_key"])
    finally:
        conn.close()
