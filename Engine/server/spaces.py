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

from . import config, cypher_utils, sqlite_util

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


def normalize_space_label_list(labels: Iterable[str] | None) -> list[str]:
    """De-dupe and trim label strings preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in labels or []:
        label = str(raw).strip()
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out


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


def _sequence_attributive_labels_from_conn(conn: sqlite3.Connection) -> set[str]:
    """attributive_labels associated with sequence queries (``kind = 'sequence'``)."""
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queries'"
    )
    if cur.fetchone() is None:
        return set()
    cur = conn.execute("SELECT cypher FROM queries WHERE kind = 'sequence'")
    labels: set[str] = set()
    for row in cur.fetchall():
        for label in _parse_sequence_cypher_labels(row[0]):
            labels.add(label)
    return labels


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


def _public_space_labels_from_conn(conn: sqlite3.Connection) -> list[str]:
    """Union of ``spaces.labels`` entries from public (is_private = 0) spaces."""
    _ensure_spaces_is_private_column(conn)
    cur = conn.execute("SELECT labels FROM spaces WHERE COALESCE(is_private, 0) = 0")
    seen: set[str] = set()
    out: list[str] = []
    for row in cur.fetchall():
        for label in parse_space_labels_column(row[0]):
            if label in seen:
                continue
            seen.add(label)
            out.append(label)
    return out


def _private_space_labels_from_conn(conn: sqlite3.Connection) -> set[str]:
    """Set of attributive_labels associated with any private (is_private = 1) space.

    Private spaces exist in isolation, so any label they own is withheld from the
    shared pool even when a public space also carries the same label.
    """
    _ensure_spaces_is_private_column(conn)
    cur = conn.execute("SELECT labels FROM spaces WHERE COALESCE(is_private, 0) = 1")
    labels: set[str] = set()
    for row in cur.fetchall():
        for label in parse_space_labels_column(row[0]):
            labels.add(label)
    return labels


def _shared_sequence_labels_from_conn(conn: sqlite3.Connection) -> list[str]:
    """
    attributive_labels from non-private spaces that are associated with a sequence query.

    Public spaces are filtered views over the shared attributive_labels (sequences being
    the main filtering mechanism), so the shared pool is the labels registered on public
    spaces (``spaces.labels`` where ``is_private = 0``) that are referenced by a sequence
    query (``queries.kind = 'sequence'``). Any label owned by a private space is excluded
    entirely. The result is sorted case-insensitively.
    """
    sequence_labels = _sequence_attributive_labels_from_conn(conn)
    if not sequence_labels:
        return []
    private_labels = _private_space_labels_from_conn(conn)
    out = [
        label
        for label in _public_space_labels_from_conn(conn)
        if label in sequence_labels and label not in private_labels
    ]
    return sorted(out, key=str.casefold)


def fetch_shared_sequence_labels() -> list[str]:
    """Shared-sequence labels available to assign when creating/editing a space."""
    with catalog_db() as conn:
        return _shared_sequence_labels_from_conn(conn)


def _space_graph_identity_from_row(row: sqlite3.Row) -> tuple[str, str]:
    """Resolved ``(neo4j_uri, neo4j_user)`` for a space row — its underlying-graph identity.

    Two spaces share an underlying graph when they resolve to the same Neo4j store, so their
    STEP attributive_labels — and therefore sequence names, which become STEP labels via the
    sequence auto-wrap — occupy a single namespace.
    """
    uri = config.env_value(row["neo4j_uri_key"], fallback_key=DEFAULT_NEO4J_URI_KEY)
    user = config.env_value(row["neo4j_user_key"], fallback_key=DEFAULT_NEO4J_USER_KEY)
    return ((uri or "").strip().casefold(), (user or "").strip())


def space_ids_sharing_graph(space_id: str) -> list[str]:
    """Ids of non-private spaces (including *space_id*) resolving to the same Neo4j graph.

    A private space is an isolated store, so it shares its graph with no other space and the
    returned cohort is just the space itself.
    """
    sid = (space_id or "").strip()
    if not sid:
        return []
    with catalog_db() as conn:
        _ensure_spaces_is_private_column(conn)
        rows = conn.execute("SELECT * FROM spaces").fetchall()
    target = next((r for r in rows if (r["id"] or "").strip() == sid), None)
    if target is None or _space_is_private_from_row(target):
        return [sid]
    target_identity = _space_graph_identity_from_row(target)
    cohort = [
        (row["id"] or "").strip()
        for row in rows
        if (row["id"] or "").strip()
        and not _space_is_private_from_row(row)
        and _space_graph_identity_from_row(row) == target_identity
    ]
    return cohort or [sid]


def sequence_name_conflict(
    space_id: str, name: str, exclude_id: str | None = None
) -> str | None:
    """Return the name of a colliding sequence in the same graph cohort, else ``None``.

    A new sequence's ``name`` becomes its wrapping STEP node's ``attributive_label``, so within
    one underlying graph two sequences may not share a name. The cohort is every non-private
    space resolving to the same Neo4j store as *space_id*; a stored sequence belongs to that
    cohort when one of its STEP labels is registered on a cohort space (``spaces.labels``), or
    when it carries no resolved labels yet — in which case it is treated as a conflict to avoid
    a latent STEP-label clash. Comparison is case-insensitive; *exclude_id* skips a re-save of
    the same row.
    """
    target = (name or "").strip()
    if not target:
        return None
    cohort = set(space_ids_sharing_graph(space_id))
    if not cohort:
        return None
    skip = (exclude_id or "").strip()
    with catalog_db() as conn:
        cohort_labels: set[str] = set()
        for row in conn.execute("SELECT id, labels FROM spaces").fetchall():
            if (row[0] or "").strip() in cohort:
                cohort_labels.update(parse_space_labels_column(row[1]))
        for seq_id, seq_name, step_labels in _sequence_rows_from_conn(conn):
            if seq_id == skip:
                continue
            if seq_name.casefold() != target.casefold():
                continue
            if not step_labels or any(label in cohort_labels for label in step_labels):
                return seq_name
        return None


def validate_space_labels_selection(
    conn: sqlite3.Connection, labels: Iterable[str] | None
) -> list[str]:
    """
    Normalize *labels* and ensure each entry is a shared-sequence label.
    """
    normalized = normalize_space_label_list(labels)
    if not normalized:
        return []
    allowed = set(_shared_sequence_labels_from_conn(conn))
    invalid = [label for label in normalized if label not in allowed]
    if invalid:
        joined = ", ".join(invalid)
        raise ValueError(
            "Labels must be shared sequences from non-private spaces "
            f"(queries.kind = 'sequence'): {joined}"
        )
    return normalized


# Any ``attributive_label: 'X'`` binding inside a Cypher statement (node, relationship,
# SCHEMA, INSTANCE — all forms). Used to harvest the SCHEMA/INSTANCE labels a STEP's query
# references when expanding a sequence's inherited-label closure.
_ATTR_LABEL_RE = cypher_utils.ATTR_LABEL_RE


def _reference_public_space_id(
    conn: sqlite3.Connection, exclude_id: str | None = None
) -> str | None:
    """
    Id of any existing non-private space, used purely to resolve a connection to the
    shared graph when expanding a sequence-label closure (all public spaces resolve to
    the same default Neo4j/SQLite store).
    """
    _ensure_spaces_is_private_column(conn)
    skip = (exclude_id or "").strip()
    cur = conn.execute(
        "SELECT id FROM spaces WHERE COALESCE(is_private, 0) = 0 ORDER BY creation_date ASC"
    )
    for row in cur.fetchall():
        sid = (row[0] or "").strip()
        if sid and sid != skip:
            return sid
    return None


def expand_sequence_label_closure(
    conn: sqlite3.Connection, selected_labels: Iterable[str]
) -> list[str]:
    """
    Expand selected shared-sequence labels to the full set of associated labels.

    A space that inherits a sequence must also inherit every label that sequence depends
    on, otherwise patterns it shows (e.g. a SCHEMA reached through the sequence's STEPs)
    are invisible to it and the SCHEMA-delete cascade's shared-space detection misses it.
    The closure walks the shared STEP workflow graph from each selected STEP label and
    adds: every STEP node/relationship label in that connected component, plus every
    ``attributive_label`` referenced by the Cypher of the queries those STEPs run
    (SCHEMA / INSTANCE / relationship patterns).

    Graph access uses a reference public space (all public spaces share one store). If no
    reference space exists or the graph is unreachable, the original selection is returned
    unchanged.
    """
    closure = {
        (raw or "").strip() for raw in selected_labels if (raw or "").strip()
    }
    if not closure:
        return []

    reference_space = _reference_public_space_id(conn)
    if not reference_space:
        return sorted(closure, key=str.casefold)

    try:
        from . import catalog, graph

        flow = graph._build_step_flow_graph(reference_space)
    except Exception:
        # Neo4j unavailable / driver missing: keep the explicit selection rather than fail
        # space creation. The closure can be backfilled later.
        return sorted(closure, key=str.casefold)

    seed_ids = [
        node["id"]
        for node in flow.get("nodes") or []
        if node.get("attributive_label") in closure and node.get("id")
    ]
    if not seed_ids:
        return sorted(closure, key=str.casefold)

    component = graph._step_flow_connected_component(flow, seed_ids)

    query_ids: set[str] = set()
    for node in component.get("nodes") or []:
        label = (node.get("attributive_label") or "").strip()
        if label:
            closure.add(label)
        query_id = str((node.get("payload") or {}).get("query_id") or "").strip()
        if query_id:
            query_ids.add(query_id)
    for rel in component.get("relationships") or []:
        label = (rel.get("attributive_label") or "").strip()
        if label:
            closure.add(label)

    for query_id in query_ids:
        package = catalog.fetch_query_package(query_id)
        if not package:
            continue
        for statement in package.get("cypher") or []:
            for match in _ATTR_LABEL_RE.finditer(str(statement or "")):
                referenced = match.group(1).strip()
                if referenced:
                    closure.add(referenced)

    return sorted(closure, key=str.casefold)


def _space_is_private_from_row(row: sqlite3.Row) -> bool:
    if "is_private" not in row.keys():
        return False
    return bool(row["is_private"])


def _space_dev_mode_from_row(row: sqlite3.Row) -> bool:
    if "dev_mode" not in row.keys():
        return False
    return bool(row["dev_mode"])


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
    ("description", "TEXT NOT NULL DEFAULT ''"),
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

    Used by the SCHEMA delete flow to unlink a space's filtered view from labels that
    are being deleted (or that remain physically present but should leave this space).
    Returns the labels actually removed and the resulting list.
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


def spaces_referencing_labels(
    attributive_labels: Iterable[str], exclude_id: str | None = None
) -> list[dict[str, str]]:
    """
    Non-private spaces (other than *exclude_id*) whose ``spaces.labels`` contains any
    of *attributive_labels*.

    Private spaces are isolated stores, so they are never reported as sharing labels
    with another space (mirrors ``_private_space_labels_from_conn`` semantics).
    """
    targets = {
        (raw or "").strip() for raw in attributive_labels if (raw or "").strip()
    }
    if not targets:
        return []

    skip = (exclude_id or "").strip()
    with catalog_db() as conn:
        _ensure_spaces_is_private_column(conn)
        cur = conn.execute(
            "SELECT id, name, labels FROM spaces WHERE COALESCE(is_private, 0) = 0"
        )
        out: list[dict[str, str]] = []
        for row in cur.fetchall():
            sid = (row[0] or "").strip()
            if not sid or sid == skip:
                continue
            labels = set(parse_space_labels_column(row[2]))
            if labels & targets:
                out.append({"id": sid, "name": str(row[1] or sid)})
        return sorted(out, key=lambda s: s["name"].casefold())


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


def space_is_private(space_id: str) -> bool:
    """True when the space is flagged private (isolated store, not part of shared pool)."""
    row = get_space_row(space_id)
    return _space_is_private_from_row(row)


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
    labels: Iterable[str] | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """
    Insert a new catalog ``spaces`` row.

    ``id`` matches the normalized ``name``. Connection env-key column values use the
    normalized prefix (uppercase, spaces as underscores); ``keys`` / ``groups`` start
    empty. ``labels`` must be shared sequences (queries.kind = 'sequence') when provided.
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

    with catalog_db() as conn:
        _ensure_spaces_groups_column(conn)
        _ensure_spaces_is_private_column(conn)
        _ensure_spaces_description_column(conn)
        if _space_name_exists(conn, sid):
            raise ValueError(f"Space name already exists: {sid!r}")

        label_list = validate_space_labels_selection(conn, labels)
        # Inherit the full dependency closure (STEP chain + referenced SCHEMA/INSTANCE
        # labels) for each selected sequence, not just the sequence's own STEP label.
        label_list = expand_sequence_label_closure(conn, label_list)
        labels_json = format_space_labels_column(label_list)
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
            "labels": label_list,
            "is_private": False,
            "description": description_val,
            "creation_date": now,
        }


def fetch_space_record(space_id: str) -> dict[str, Any]:
    """
    Return id, name, endpoint, labels, sequence_labels, is_private, and dev_mode.

    ``labels`` is the full stored view (sequence labels plus the inherited STEP/SCHEMA
    closure). ``sequence_labels`` is the user-selectable subset (the labels that are the
    initial STEP of a sequence) — the edit modal pre-selects these so a re-save round-trips
    through the closure expansion instead of trying to re-validate derived labels.
    """
    row = get_space_row(space_id)
    labels = parse_space_labels_column(row["labels"])
    with catalog_db() as conn:
        sequence_universe = _sequence_attributive_labels_from_conn(conn)
    sequence_labels = [label for label in labels if label in sequence_universe]
    return {
        "id": row["id"],
        "name": row["name"],
        "endpoint": _space_endpoint_from_row(row),
        "labels": labels,
        "sequence_labels": sequence_labels,
        "is_private": _space_is_private_from_row(row),
        "dev_mode": _space_dev_mode_from_row(row),
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
    labels: Iterable[str] | None = None,
    *,
    set_labels: bool = False,
    description: str | None = None,
    set_description: bool = False,
) -> dict[str, Any]:
    """
    Update a catalog ``spaces`` row (name, endpoint, and optionally labels).

    Renaming recomputes ``id`` and all connection env-key columns from the normalized
    name, matching :func:`create_space`. When ``set_labels`` is true, ``labels`` must
    be shared sequences (queries.kind = 'sequence').
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
        _ensure_spaces_description_column(conn)
        cur = conn.execute("SELECT id FROM spaces WHERE id = ?", (sid,))
        if cur.fetchone() is None:
            raise ValueError(f"Unknown space id: {sid!r}")
        if _space_name_taken(conn, new_id, exclude_id=sid):
            raise ValueError(f"Space name already exists: {new_id!r}")

        label_list: list[str] | None = None
        labels_json: str | None = None
        if set_labels:
            label_list = validate_space_labels_selection(conn, labels)
            label_list = expand_sequence_label_closure(conn, label_list)
            labels_json = format_space_labels_column(label_list)

        neo_uri_key, neo_user_key, neo_pass_key, sqlite_path_key = space_connection_env_keys(
            new_id
        )

        if set_labels:
            conn.execute(
                """
                UPDATE spaces SET
                    id = ?, name = ?, endpoint = ?, labels = ?,
                    neo4j_uri_key = ?, neo4j_user_key = ?, neo4j_password_key = ?,
                    sqlite_database_path_key = ?
                WHERE id = ?
                """,
                (
                    new_id,
                    new_id,
                    endpoint_val,
                    labels_json,
                    neo_uri_key,
                    neo_user_key,
                    neo_pass_key,
                    sqlite_path_key,
                    sid,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE spaces SET
                    id = ?, name = ?, endpoint = ?,
                    neo4j_uri_key = ?, neo4j_user_key = ?, neo4j_password_key = ?,
                    sqlite_database_path_key = ?
                WHERE id = ?
                """,
                (
                    new_id,
                    new_id,
                    endpoint_val,
                    neo_uri_key,
                    neo_user_key,
                    neo_pass_key,
                    sqlite_path_key,
                    sid,
                ),
            )
        description_val: str | None = None
        if set_description:
            description_val = (description or "").strip()
            conn.execute(
                "UPDATE spaces SET description = ? WHERE id = ?",
                (description_val, new_id),
            )
        conn.commit()
        result: dict[str, Any] = {
            "id": new_id,
            "name": new_id,
            "endpoint": endpoint_val,
        }
        if set_labels:
            result["labels"] = label_list or []
        if set_description:
            result["description"] = description_val or ""
        return result


def delete_space(space_id: str) -> dict[str, Any]:
    """Remove a space and its space-scoped catalog rows.

    Cascades over ``space_members``, ``space_roles``, ``events``, ``agent_keys``, and
    the synthetic agent ``users`` rows that exist only for this space's keys (the
    catalog has no foreign keys, so orphans would otherwise accumulate — and a stale
    ``agent_keys`` row would keep authenticating). ``audit_log`` rows are deliberately
    kept as run history. Per-space Neo4j/SQLite data files are not touched.
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
        for table in ("agent_keys", "events", "space_members", "space_roles"):
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
