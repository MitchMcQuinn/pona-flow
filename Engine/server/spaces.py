"""
Space registry and per-space connection resolution.

Purpose in the project
----------------------
pona flow supports multiple isolated **spaces** (working environments). Each space
row in the catalog ``spaces`` table stores *names* of .env keys—not secrets themselves—
for:

- Per-space SQLite (entity payloads, etc.)
- Neo4j URI, user, and password

The React QUERY builder lists spaces from ``GET /api/spaces`` and loads resolved
connection details via ``GET /api/space/connections``. Package execution and graph
validation always take a ``space_id`` and use this module to open the correct databases.

Importance
----------
This module is the **routing layer** between one shared catalog (``data.db``) and many
runtime backends. Without it, the UI could not offer a space dropdown or run Cypher/SQL
against the correct graph and SQLite file for the selected environment.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config, sqlite_util

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"
_ENTITIES_TABLE_SQL = _SCHEMA_DIR / "entities-table.sql"


@contextmanager
def catalog_db() -> Iterator[sqlite3.Connection]:
    """Context-managed raw catalog connection (no lazy table ensures — this module
    owns the ``spaces`` schema itself; see ``catalog.catalog_connection`` for the
    ensure-everything variant). Closing without commit discards uncommitted writes."""
    conn = config.connect_sqlite(config.catalog_sqlite_path())  # opened here only
    try:
        yield conn
    finally:
        conn.close()  # the sole explicit close; call sites use this manager


def _spaces_sort_column(conn: sqlite3.Connection) -> str:
    """Pick modified_date or creation_date for ordering spaces (legacy schema support)."""
    cur = conn.execute("PRAGMA table_info(spaces)")
    cols = {row[1] for row in cur.fetchall()}
    if "modified_date" in cols:
        return "modified_date"
    return "creation_date"


def _row_to_space_keys(row: sqlite3.Row) -> dict[str, str]:
    return {
        "sqlite_database_path_key": row["sqlite_database_path_key"],
        "neo4j_uri_key": row["neo4j_uri_key"],
        "neo4j_user_key": row["neo4j_user_key"],
        "neo4j_password_key": row["neo4j_password_key"],
    }


def get_space_row(space_id: str) -> sqlite3.Row:
    """Load one row from catalog ``spaces``; raise if unknown id."""
    with catalog_db() as conn:
        _ensure_spaces_dev_mode_column(conn)
        _ensure_spaces_hide_empty_groups_column(conn)
        cur = conn.execute("SELECT * FROM spaces WHERE id = ?", (space_id,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {space_id!r}")
        return row


def sqlite_path_for_space(space_id: str) -> Path:
    """Resolve SQLite file path for a space, falling back to the shared default key."""
    row = get_space_row(space_id)
    return config.sqlite_path_for_env_key(
        row["sqlite_database_path_key"], fallback_key=DEFAULT_SQLITE_DATABASE_PATH_KEY
    )


def neo4j_config_for_space(space_id: str) -> dict[str, str]:
    """
    Resolve Neo4j connection settings for a space via its neo4j_*_key columns.

    Each space-specific key falls back to the shared default key (e.g.
    ``NEO4J_URI``) when its own override is not set in the environment.
    """
    row = get_space_row(space_id)
    return {
        "uri": config.env_value(row["neo4j_uri_key"], fallback_key=DEFAULT_NEO4J_URI_KEY),
        "user": config.env_value(row["neo4j_user_key"], fallback_key=DEFAULT_NEO4J_USER_KEY),
        "password": config.env_value(
            row["neo4j_password_key"], fallback_key=DEFAULT_NEO4J_PASSWORD_KEY
        ),
    }


def _entities_table_columns(conn: sqlite3.Connection) -> set[str]:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'"
    )
    if cur.fetchone() is None:
        return set()
    cur = conn.execute("PRAGMA table_info(entities)")
    return {row[1] for row in cur.fetchall()}


def _ensure_entities_schema(conn: sqlite3.Connection) -> None:
    """Ensure per-space ``entities`` exists and has node_label, common_label, parameters."""
    cols = _entities_table_columns(conn)
    if not cols:
        if _ENTITIES_TABLE_SQL.is_file():
            conn.executescript(_ENTITIES_TABLE_SQL.read_text(encoding="utf-8"))
        else:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY NOT NULL,
                    node_label TEXT NOT NULL,
                    common_label TEXT,
                    parameters TEXT,
                    payload TEXT,
                    creation_date TEXT NOT NULL DEFAULT (datetime('now')),
                    modified_date TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        conn.commit()
        return
    if "label" in cols and "node_label" not in cols:
        conn.execute("ALTER TABLE entities RENAME COLUMN label TO node_label")
        cols.discard("label")
        cols.add("node_label")
    if "common_label" not in cols:
        conn.execute("ALTER TABLE entities ADD COLUMN common_label TEXT")
    if "parameters" not in cols:
        conn.execute("ALTER TABLE entities ADD COLUMN parameters TEXT")
    conn.commit()


def entities_node_label_column(conn: sqlite3.Connection) -> str:
    """Return the entities column holding STEP/SCHEMA/INSTANCE (after migration)."""
    _ensure_entities_schema(conn)
    cols = _entities_table_columns(conn)
    if "node_label" in cols:
        return "node_label"
    if "label" in cols:
        return "label"
    raise ValueError("entities table is missing node_label and label columns")


def connect_sqlite_for_space(space_id: str) -> sqlite3.Connection:
    """Open the per-space SQLite database (not the catalog)."""
    conn = config.connect_sqlite(sqlite_path_for_space(space_id))
    _ensure_entities_schema(conn)
    return conn


def parse_space_labels_column(raw: str | None) -> list[str]:
    """Parse spaces.labels JSON (`{"labels":[...]}`) into a list of strings."""
    if raw is None:
        return []
    text = str(raw).strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and isinstance(data.get("labels"), list):
        return [str(item).strip() for item in data["labels"] if str(item).strip()]
    if isinstance(data, list):
        return [str(item).strip() for item in data if str(item).strip()]
    return []


def format_space_labels_column(labels: list[str]) -> str:
    """Serialize attributive_label names for the spaces.labels column."""
    return json.dumps({"labels": labels}, separators=(",", ":"))


# A sequence read query matches its initial STEP node by attributive_label, e.g.
#   MATCH (alias:STEP { attributive_label: 'STEP_LABEL' }) RETURN *
_SEQUENCE_STEP_LABEL_RE = re.compile(
    r":STEP\s*\{[^}]*?attributive_label\s*:\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)


def _parse_sequence_cypher_labels(raw_cypher: str | None) -> list[str]:
    """attributive_labels referenced by a sequence query's ``cypher`` JSON array."""
    if not raw_cypher:
        return []
    try:
        statements = json.loads(raw_cypher)
    except json.JSONDecodeError:
        return []
    if not isinstance(statements, list):
        return []
    out: list[str] = []
    for stmt in statements:
        for match in _SEQUENCE_STEP_LABEL_RE.finditer(str(stmt or "")):
            label = match.group(1).strip()
            if label:
                out.append(label)
    return out


def _sequence_rows_from_conn(
    conn: sqlite3.Connection,
) -> list[tuple[str, str, list[str]]]:
    """``(id, name, step_labels)`` for every ``queries.kind = 'sequence'`` row."""
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queries'"
    )
    if cur.fetchone() is None:
        return []
    cur = conn.execute("SELECT id, name, cypher FROM queries WHERE kind = 'sequence'")
    out: list[tuple[str, str, list[str]]] = []
    for row in cur.fetchall():
        out.append(
            (
                (row[0] or "").strip(),
                (row[1] or "").strip(),
                _parse_sequence_cypher_labels(row[2]),
            )
        )
    return out


def sequence_name_conflict(
    space_id: str, name: str, exclude_id: str | None = None
) -> str | None:
    """Return the name of a colliding sequence in this space, else ``None``.

    A new sequence's ``name`` becomes its wrapping STEP node's ``attributive_label``, so
    two sequences in the same space may not share a *create-time* name. A stored sequence
    belongs to this space when one of its STEP labels is registered on ``spaces.labels``.
    Comparison is case-insensitive; *exclude_id* skips a re-save of the same row.
    Graph-global wrap uniqueness is enforced separately at package execute time.
    """
    target = (name or "").strip()
    sid = (space_id or "").strip()
    if not target or not sid:
        return None
    skip = (exclude_id or "").strip()
    with catalog_db() as conn:
        cur = conn.execute("SELECT labels FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        space_labels = set(parse_space_labels_column(row[0] if row else None))
        if not space_labels:
            return None
        for seq_id, seq_name, step_labels in _sequence_rows_from_conn(conn):
            if seq_id == skip:
                continue
            if seq_name.casefold() != target.casefold():
                continue
            if any(label in space_labels for label in step_labels):
                return seq_name
        return None


def _space_is_private_from_row(row: sqlite3.Row) -> bool:
    if "is_private" not in row.keys():
        return False
    return bool(row["is_private"])


def _space_dev_mode_from_row(row: sqlite3.Row) -> bool:
    try:
        return bool(row["dev_mode"])
    except (KeyError, IndexError):
        return False


def _space_hide_empty_groups_from_row(row: sqlite3.Row) -> bool:
    try:
        return bool(row["hide_empty_sequence_groups"])
    except (KeyError, IndexError):
        return False


def append_space_attributive_labels(
    space_id: str, attributive_labels: Iterable[str]
) -> dict[str, Any]:
    """
    Append attributive_label strings to catalog ``spaces.labels`` for *space_id*.

    Existing entries are preserved; duplicates (exact match after strip) are skipped.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    with catalog_db() as conn:
        cur = conn.execute("SELECT labels FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")

        existing = parse_space_labels_column(row[0])
        seen = set(existing)
        added: list[str] = []
        for raw in attributive_labels:
            al = (raw or "").strip()
            if not al or al in seen:
                continue
            seen.add(al)
            existing.append(al)
            added.append(al)

        if added:
            conn.execute(
                "UPDATE spaces SET labels = ? WHERE id = ?",
                (format_space_labels_column(existing), sid),
            )
            conn.commit()

        return {"added": added, "labels": existing}


# Columns added to the catalog ``spaces`` table over time (legacy DBs get them via
# additive ALTERs). ``description`` doubles as the MCP server's ``instructions`` —
# overall guidance on what the space's toolset is for.
_SPACES_COLUMN_MIGRATIONS = (
    ("groups", "TEXT NOT NULL DEFAULT '{\"groups\":[]}'"),
    ("is_private", "INTEGER NOT NULL DEFAULT 0"),
    ("dev_mode", "INTEGER NOT NULL DEFAULT 0"),
    ("hide_empty_sequence_groups", "INTEGER NOT NULL DEFAULT 0"),
    ("description", "TEXT NOT NULL DEFAULT ''"),
    ("embeddings_config", "TEXT NOT NULL DEFAULT '{}'"),
)


def _apply_spaces_column_migrations(conn: sqlite3.Connection) -> None:
    for column, ddl in _SPACES_COLUMN_MIGRATIONS:
        sqlite_util.ensure_column(conn, "spaces", column, ddl)


def _ensure_spaces_groups_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.groups`` JSON column for nav group titles (legacy DBs)."""
    sqlite_util.ensure_column(
        conn, "spaces", "groups", "TEXT NOT NULL DEFAULT '{\"groups\":[]}'"
    )


def _ensure_spaces_is_private_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.is_private`` flag (0 = public, 1 = private)."""
    sqlite_util.ensure_column(
        conn, "spaces", "is_private", "INTEGER NOT NULL DEFAULT 0"
    )


def _ensure_spaces_dev_mode_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.dev_mode`` flag (0 = off, 1 = on)."""
    sqlite_util.ensure_column(conn, "spaces", "dev_mode", "INTEGER NOT NULL DEFAULT 0")


def _ensure_spaces_hide_empty_groups_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.hide_empty_sequence_groups`` flag (0 = show empty groups)."""
    sqlite_util.ensure_column(
        conn, "spaces", "hide_empty_sequence_groups", "INTEGER NOT NULL DEFAULT 0"
    )


def _ensure_spaces_description_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.description`` prose column (legacy DBs)."""
    sqlite_util.ensure_column(
        conn, "spaces", "description", "TEXT NOT NULL DEFAULT ''"
    )


def _space_description_from_row(row: sqlite3.Row) -> str:
    if "description" not in row.keys():
        return ""
    return str(row["description"] or "")


def parse_space_groups_column(raw: str | None) -> list[str]:
    """Parse spaces.groups JSON (`{"groups":[...]}`) into a list of strings."""
    if raw is None:
        return []
    text = str(raw).strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and isinstance(data.get("groups"), list):
        return [str(item).strip() for item in data["groups"] if str(item).strip()]
    if isinstance(data, list):
        return [str(item).strip() for item in data if str(item).strip()]
    return []


def format_space_groups_column(groups: list[str]) -> str:
    """Serialize group titles for the spaces.groups column."""
    return json.dumps({"groups": groups}, separators=(",", ":"))


def _ensure_spaces_embeddings_config_column(conn: sqlite3.Connection) -> None:
    """Add catalog ``spaces.embeddings_config`` JSON column (legacy DBs)."""
    sqlite_util.ensure_column(
        conn, "spaces", "embeddings_config", "TEXT NOT NULL DEFAULT '{}'"
    )


def parse_space_embeddings_config(raw: str | None) -> dict[str, Any]:
    """Parse spaces.embeddings_config JSON into a normalized dict.

    Vector-search settings for a space: whether the feature is on, which local Ollama
    serves it, and the model's vector width (probed on save, not typed by hand — the
    dimension is baked into the Neo4j index). An unset/corrupt column reads as ``{}``,
    which means "never configured" and lets the instance env vars stand in.
    """
    if raw is None:
        return {}
    text = str(raw).strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict) or not data:
        return {}
    dimensions = data.get("dimensions")
    try:
        dims = int(dimensions) if dimensions not in (None, "") else None
    except (TypeError, ValueError):
        dims = None
    return {
        "enabled": bool(data.get("enabled")),
        "ollama_url": str(data.get("ollama_url") or "").strip(),
        "embed_model": str(data.get("embed_model") or "").strip(),
        "dimensions": dims,
    }


def format_space_embeddings_config(cfg: dict[str, Any]) -> str:
    """Serialize vector-search settings for the spaces.embeddings_config column."""
    payload = {
        "enabled": bool(cfg.get("enabled")),
        "ollama_url": str(cfg.get("ollama_url") or "").strip(),
        "embed_model": str(cfg.get("embed_model") or "").strip(),
        "dimensions": cfg.get("dimensions"),
    }
    return json.dumps(payload, separators=(",", ":"))


def fetch_space_embeddings_config(space_id: str) -> dict[str, Any]:
    """Read a space's stored vector-search settings (``{}`` when never configured)."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    with catalog_db() as conn:
        _ensure_spaces_embeddings_config_column(conn)
        conn.commit()
        cur = conn.execute("SELECT embeddings_config FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        return parse_space_embeddings_config(row["embeddings_config"])


def write_space_embeddings_config(space_id: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """Persist a space's vector-search settings verbatim (no policy checks here).

    Validation and the Neo4j index lifecycle live in ``server.embeddings``; this is the
    storage half only.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    with catalog_db() as conn:
        _ensure_spaces_embeddings_config_column(conn)
        cur = conn.execute("SELECT id FROM spaces WHERE id = ?", (sid,))
        if cur.fetchone() is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        conn.execute(
            "UPDATE spaces SET embeddings_config = ? WHERE id = ?",
            (format_space_embeddings_config(cfg), sid),
        )
        conn.commit()
    return fetch_space_embeddings_config(sid)


def append_space_group(space_id: str, group_title: str) -> dict[str, Any]:
    """Append a group title to catalog ``spaces.groups`` for *space_id* (deduped)."""
    sid = (space_id or "").strip()
    title = (group_title or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not title:
        raise ValueError("group_title is required")

    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        cur = conn.execute("SELECT groups FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")

        existing = parse_space_groups_column(row[0])
        if any(g.casefold() == title.casefold() for g in existing):
            return {"added": [], "groups": existing}

        existing.append(title)
        conn.execute(
            "UPDATE spaces SET groups = ? WHERE id = ?",
            (format_space_groups_column(existing), sid),
        )
        conn.commit()
        return {"added": [title], "groups": existing}


def canonical_group_title(space_id: str, group_title: str) -> str:
    """Return an existing group title that matches *group_title* case-insensitively, else trimmed.

    Group titles are unique within a space, so a newly entered title that only differs from an
    existing one by case must resolve to the existing canonical casing — otherwise the nav would
    file the query under a second, visually identical group.
    """
    title = (group_title or "").strip()
    if not title:
        return ""
    for existing in fetch_space_groups(space_id):
        if existing.casefold() == title.casefold():
            return existing
    return title


def remove_space_attributive_labels(
    space_id: str, attributive_labels: Iterable[str]
) -> dict[str, Any]:
    """
    Remove attributive_label strings from catalog ``spaces.labels`` for *space_id*.

    Used by the SCHEMA/STEP delete flow to drop purged labels from this space's
    nav index. Returns the labels actually removed and the resulting list.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    targets = {
        (raw or "").strip() for raw in attributive_labels if (raw or "").strip()
    }
    if not targets:
        return {"removed": [], "labels": fetch_space_labels(sid)}

    with catalog_db() as conn:
        cur = conn.execute("SELECT labels FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")

        existing = parse_space_labels_column(row[0])
        remaining = [label for label in existing if label not in targets]
        removed = [label for label in existing if label in targets]

        if removed:
            conn.execute(
                "UPDATE spaces SET labels = ? WHERE id = ?",
                (format_space_labels_column(remaining), sid),
            )
            conn.commit()

        return {"removed": removed, "labels": remaining}


def remove_attributive_labels_from_all_spaces(
    attributive_labels: Iterable[str],
) -> dict[str, list[str]]:
    """Remove attributive_label strings from every space's ``labels`` array.

    Used after a SCHEMA/STEP purge so leftover overlapping indexes do not show
    ghost nav items. Returns ``{space_id: [removed, ...]}`` for spaces that
    actually lost labels.
    """
    targets = {
        (raw or "").strip() for raw in attributive_labels if (raw or "").strip()
    }
    if not targets:
        return {}

    with catalog_db() as conn:
        cur = conn.execute("SELECT id, labels FROM spaces")
        stripped: dict[str, list[str]] = {}
        for row in cur.fetchall():
            sid = (row[0] or "").strip()
            if not sid:
                continue
            existing = parse_space_labels_column(row[1])
            remaining = [label for label in existing if label not in targets]
            removed = [label for label in existing if label in targets]
            if not removed:
                continue
            conn.execute(
                "UPDATE spaces SET labels = ? WHERE id = ?",
                (format_space_labels_column(remaining), sid),
            )
            stripped[sid] = removed
        if stripped:
            conn.commit()
        return stripped


def set_space_groups(space_id: str, groups: Iterable[str]) -> dict[str, Any]:
    """Replace catalog ``spaces.groups`` with an ordered, de-duplicated title list.

    Powers nav-bar group add / reorder / delete (the full ordered list is sent each time).
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in groups:
        title = (str(raw) if raw is not None else "").strip()
        key = title.casefold()
        if not title or key in seen:
            continue
        seen.add(key)
        cleaned.append(title)

    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        cur = conn.execute("SELECT id FROM spaces WHERE id = ?", (sid,))
        if cur.fetchone() is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        conn.execute(
            "UPDATE spaces SET groups = ? WHERE id = ?",
            (format_space_groups_column(cleaned), sid),
        )
        conn.commit()
        return {"groups": cleaned}


def fetch_space_groups(space_id: str) -> list[str]:
    """Return group title strings from catalog ``spaces.groups`` for *space_id*."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        cur = conn.execute("SELECT groups FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        return parse_space_groups_column(row[0])


def fetch_space_labels(space_id: str) -> list[str]:
    """Return attributive_label strings from catalog ``spaces.labels`` for *space_id*."""
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    with catalog_db() as conn:
        cur = conn.execute("SELECT labels FROM spaces WHERE id = ?", (sid,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        return parse_space_labels_column(row[0])


def ensure_catalog_space_schema(conn: sqlite3.Connection | None = None) -> None:
    """Ensure catalog ``spaces`` schema columns exist (safe to call repeatedly)."""
    if conn is None:
        with catalog_db() as own_conn:
            _apply_spaces_column_migrations(own_conn)
        return
    _apply_spaces_column_migrations(conn)


def normalize_space_name(raw: str) -> str:
    """
    Catalog space id / env-key prefix: uppercase, spaces → underscores, then strip
    anything that is not alphanumeric or underscore (e.g. ``Test space`` → ``TEST_SPACE``).
    """
    text = (raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", "_", text.upper())
    text = re.sub(r"[^A-Z0-9_]", "", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text


def space_connection_env_keys(space_id: str) -> tuple[str, str, str, str]:
    """Neo4j/SQLite env var names for a catalog space (``neo4j_uri_key`` column values)."""
    prefix = (space_id or "").strip()
    return (
        f"{prefix}_NEO4J_URI",
        f"{prefix}_NEO4J_USER",
        f"{prefix}_NEO4J_PASSWORD",
        f"{prefix}_SQLITE_DATABASE_PATH",
    )


# Shared default .env keys. When a space's own prefixed key (e.g.
# ``NEW_SPACE_NEO4J_URI``) is not set, resolution falls back to these.
DEFAULT_NEO4J_URI_KEY = "NEO4J_URI"
DEFAULT_NEO4J_USER_KEY = "NEO4J_USER"
DEFAULT_NEO4J_PASSWORD_KEY = "NEO4J_PASSWORD"
DEFAULT_SQLITE_DATABASE_PATH_KEY = "SQLITE_DATABASE_PATH"


def validate_space_name_input(raw: str) -> None:
    """Raise when the raw name is empty or contains non-alphanumeric characters."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("name is required")
    if re.search(r"[^A-Za-z0-9\s]", text):
        raise ValueError("Space name may only contain letters, numbers, and spaces.")
    if not normalize_space_name(text):
        raise ValueError("name is required")


def _space_name_taken(
    conn: sqlite3.Connection, normalized_name: str, exclude_id: str | None = None
) -> bool:
    """True when another space row already uses this normalized id/name."""
    if exclude_id:
        cur = conn.execute(
            "SELECT 1 FROM spaces WHERE (id = ? OR LOWER(name) = LOWER(?)) AND id != ? LIMIT 1",
            (normalized_name, normalized_name, exclude_id),
        )
    else:
        cur = conn.execute(
            "SELECT 1 FROM spaces WHERE id = ? OR LOWER(name) = LOWER(?) LIMIT 1",
            (normalized_name, normalized_name),
        )
    return cur.fetchone() is not None


def _space_name_exists(conn: sqlite3.Connection, name: str) -> bool:
    """True when a space row already uses this id or name (case-insensitive name)."""
    return _space_name_taken(conn, name)


def create_space(
    name: str,
    endpoint: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """
    Insert a new catalog ``spaces`` row.

    ``id`` matches the normalized ``name``. Connection env-key column values use the
    normalized prefix (uppercase, spaces as underscores); ``keys`` / ``groups`` /
    ``labels`` start empty. Labels are registered later when this space creates or
    imports graph elements.
    """
    validate_space_name_input(name)
    sid = normalize_space_name(name)
    if not sid:
        raise ValueError("name is required")

    endpoint_val = (endpoint or "").strip() or None
    description_val = (description or "").strip()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    keys_json = json.dumps({"keys": []}, separators=(",", ":"))
    groups_json = format_space_groups_column([])
    labels_json = format_space_labels_column([])

    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        _ensure_spaces_is_private_column(conn)
        _ensure_spaces_dev_mode_column(conn)
        _ensure_spaces_hide_empty_groups_column(conn)
        _ensure_spaces_description_column(conn)
        if _space_name_exists(conn, sid):
            raise ValueError(f"Space name already exists: {sid!r}")

        neo_uri_key, neo_user_key, neo_pass_key, sqlite_path_key = space_connection_env_keys(
            sid
        )

        conn.execute(
            """
            INSERT INTO spaces (
                id, name, endpoint, labels, keys,
                neo4j_uri_key, neo4j_user_key, neo4j_password_key,
                sqlite_database_path_key, creation_date, groups, is_private, description
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sid,
                sid,
                endpoint_val,
                labels_json,
                keys_json,
                neo_uri_key,
                neo_user_key,
                neo_pass_key,
                sqlite_path_key,
                now,
                groups_json,
                0,
                description_val,
            ),
        )
        conn.commit()
        return {
            "id": sid,
            "name": sid,
            "endpoint": endpoint_val,
            "labels": [],
            "is_private": False,
            "description": description_val,
            "creation_date": now,
        }


def fetch_space_record(space_id: str) -> dict[str, Any]:
    """Return id, name, endpoint, labels, is_private, and UI flags.

    ``labels`` is this space's local nav index (attributive_labels created or imported
    here). ``is_private`` is kept in the payload for compatibility; it is no longer
    used to gate sharing.
    """
    row = get_space_row(space_id)
    return {
        "id": row["id"],
        "name": row["name"],
        "endpoint": _space_endpoint_from_row(row),
        "labels": parse_space_labels_column(row["labels"]),
        "is_private": _space_is_private_from_row(row),
        "dev_mode": _space_dev_mode_from_row(row),
        "hide_empty_sequence_groups": _space_hide_empty_groups_from_row(row),
        "description": _space_description_from_row(row),
    }


def fetch_space_description(space_id: str) -> str:
    """Return a space's prose description (empty string if unset/unknown)."""
    sid = (space_id or "").strip()
    if not sid:
        return ""
    try:
        row = get_space_row(sid)
    except ValueError:
        return ""
    return _space_description_from_row(row)


def update_space(
    space_id: str,
    name: str,
    endpoint: str | None = None,
    *,
    description: str | None = None,
    set_description: bool = False,
    dev_mode: bool | None = None,
    set_dev_mode: bool = False,
    hide_empty_sequence_groups: bool | None = None,
    set_hide_empty_sequence_groups: bool = False,
) -> dict[str, Any]:
    """
    Update a catalog ``spaces`` row (name, endpoint, and settings flags).

    Renaming recomputes ``id`` and all connection env-key columns from the normalized
    name, matching :func:`create_space`. ``dev_mode`` is the builder flag that surfaces
    composed Cypher and SQLite previews. ``hide_empty_sequence_groups`` hides named nav
    groups that currently hold no sequences. Labels are not a settings field.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    validate_space_name_input(name)
    new_id = normalize_space_name(name)
    if not new_id:
        raise ValueError("name is required")

    endpoint_val = (endpoint or "").strip() or None

    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        _ensure_spaces_is_private_column(conn)
        _ensure_spaces_dev_mode_column(conn)
        _ensure_spaces_hide_empty_groups_column(conn)
        _ensure_spaces_description_column(conn)
        cur = conn.execute("SELECT id FROM spaces WHERE id = ?", (sid,))
        if cur.fetchone() is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        if _space_name_taken(conn, new_id, exclude_id=sid):
            raise ValueError(f"Space name already exists: {new_id!r}")

        neo_uri_key, neo_user_key, neo_pass_key, sqlite_path_key = space_connection_env_keys(
            new_id
        )

        assignments = [
            "id = ?",
            "name = ?",
            "endpoint = ?",
            "neo4j_uri_key = ?",
            "neo4j_user_key = ?",
            "neo4j_password_key = ?",
            "sqlite_database_path_key = ?",
        ]
        params: list[Any] = [
            new_id,
            new_id,
            endpoint_val,
            neo_uri_key,
            neo_user_key,
            neo_pass_key,
            sqlite_path_key,
        ]
        description_val: str | None = None
        if set_description:
            description_val = (description or "").strip()
            assignments.append("description = ?")
            params.append(description_val)
        dev_mode_val: bool | None = None
        if set_dev_mode:
            dev_mode_val = bool(dev_mode)
            assignments.append("dev_mode = ?")
            params.append(1 if dev_mode_val else 0)
        hide_empty_val: bool | None = None
        if set_hide_empty_sequence_groups:
            hide_empty_val = bool(hide_empty_sequence_groups)
            assignments.append("hide_empty_sequence_groups = ?")
            params.append(1 if hide_empty_val else 0)
        params.append(sid)
        conn.execute(
            f"UPDATE spaces SET {', '.join(assignments)} WHERE id = ?",
            params,
        )
        conn.commit()
        result: dict[str, Any] = {
            "id": new_id,
            "name": new_id,
            "endpoint": endpoint_val,
        }
        if set_description:
            result["description"] = description_val or ""
        if set_dev_mode:
            result["dev_mode"] = bool(dev_mode_val)
        if set_hide_empty_sequence_groups:
            result["hide_empty_sequence_groups"] = bool(hide_empty_val)
        return result


def delete_space(space_id: str) -> dict[str, Any]:
    """Remove a space and its space-scoped catalog rows.

    Cascades over ``space_members``, ``space_roles``, ``events``, ``agent_keys``,
    ``local_llm_configs``, and the synthetic agent ``users`` rows that exist only for
    this space's keys (the catalog has no foreign keys, so orphans would otherwise
    accumulate — and a stale ``agent_keys`` row would keep authenticating). ``audit_log``
    rows are deliberately kept as run history. Per-space Neo4j/SQLite data files are not
    touched.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")

    with catalog_db() as conn:
        cur = conn.execute("DELETE FROM spaces WHERE id = ?", (sid,))
        if cur.rowcount == 0:
            raise ValueError(f"Unknown space id: {sid!r}")
        # Agent principals are created per key and have no identity outside this space.
        conn.execute(
            "DELETE FROM users WHERE principal_type = 'agent' AND id IN "
            "(SELECT principal_id FROM agent_keys WHERE space_id = ?)",
            (sid,),
        )
        for table in (
            "agent_keys",
            "events",
            "space_members",
            "space_roles",
            "local_llm_configs",
        ):
            conn.execute(f"DELETE FROM {table} WHERE space_id = ?", (sid,))
        conn.commit()
        return {"id": sid, "deleted": True}


def fetch_spaces() -> list[dict[str, Any]]:
    """List spaces for the QUERY form dropdown (newest sort_date first)."""
    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        sort_col = _spaces_sort_column(conn)
        sql = (
            f"SELECT id, name, {sort_col} AS sort_date, sqlite_database_path_key "
            f"FROM spaces ORDER BY sort_date DESC, name ASC"
        )
        cur = conn.execute(sql)
        return [
            {
                "id": row[0],
                "name": row[1],
                "sort_date": row[2],
                "sqlite_database_path_key": row[3],
            }
            for row in cur.fetchall()
        ]


def _space_endpoint_from_row(row: sqlite3.Row) -> str:
    if "endpoint" not in row.keys():
        return ""
    raw = row["endpoint"]
    if raw is None:
        return ""
    return str(raw).strip()


def space_connections_payload(space_id: str) -> dict[str, Any]:
    """
    JSON payload for GET /api/space/connections.

    Exposes resolved paths and Neo4j settings for UI hints (password is not sent,
    only password_configured boolean).
    """
    row = get_space_row(space_id)
    keys = _row_to_space_keys(row)
    sqlite_env_key = keys["sqlite_database_path_key"]
    sqlite_path = config.sqlite_path_for_env_key(
        sqlite_env_key, fallback_key=DEFAULT_SQLITE_DATABASE_PATH_KEY
    )
    neo_uri_key = keys["neo4j_uri_key"]
    neo_user_key = keys["neo4j_user_key"]
    neo_pass_key = keys["neo4j_password_key"]
    password_val = config.env_value(neo_pass_key, fallback_key=DEFAULT_NEO4J_PASSWORD_KEY)
    return {
        "space_id": space_id,
        "name": row["name"],
        "endpoint": _space_endpoint_from_row(row),
        "catalog_sqlite_env_key": config.catalog_sqlite_env_key(),
        "sqlite": {
            "env_key": sqlite_env_key,
            "path": str(sqlite_path),
        },
        "neo4j": {
            "uri_env_key": neo_uri_key,
            "user_env_key": neo_user_key,
            "password_env_key": neo_pass_key,
            "uri": config.env_value(neo_uri_key, fallback_key=DEFAULT_NEO4J_URI_KEY),
            "user": config.env_value(neo_user_key, fallback_key=DEFAULT_NEO4J_USER_KEY),
            "password_configured": bool(password_val),
        },
    }
