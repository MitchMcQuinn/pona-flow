"""
Catalog database (data.db) access — schema introspection, CRUD, and migrations.

Purpose in the project
----------------------
The catalog SQLite file is the **system of record** for:

- ``spaces`` — environment registry (see ``spaces`` module for resolution)
- ``queries`` — saved QUERY/CRUD executor packages (Cypher/SQLite/parameter JSON arrays)
- ``regex`` — string format validation patterns for the QUERY form
- ``state`` — persisted EXECUTION packages with lifecycle status
- Any other tables exposed in ``App/data-db-editor.html``

This module powers ``GET/POST /api/db/*`` (generic table editor) and catalog-specific
logic used when persisting packages. On first connect it can auto-create the ``regex``
table from ``Engine/schema/regex-table.sql``. It also migrates legacy ``queries`` tables
to add policy columns used by STEP authoring/runtime query selection.

Importance
----------
Separating catalog access keeps the HTTP handler ignorant of SQL details and ensures
both UIs (QUERY form + db editor) share one implementation for row insert/update/delete
and metadata discovery.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from . import config
from . import cypher_utils
from . import spaces
from . import sqlite_util

_STATE_STATUSES = ("active", "pending", "waiting", "cancelled", "inactive")
_IN_FLIGHT_STATUSES = ("active", "pending", "waiting")
_FINISHED_STATUSES = ("inactive", "cancelled")

_REGEX_TABLE_SQL = config.ROOT / "Engine" / "schema" / "regex-table.sql"
_STATE_TABLE_SQL = config.ROOT / "Engine" / "schema" / "state-table.sql"
_EVENTS_TABLE_SQL = config.ROOT / "Engine" / "schema" / "events-table.sql"
_CONSOLES_TABLE_SQL = config.ROOT / "Engine" / "schema" / "consoles-table.sql"
_SIMULATION_TABLES_SQL = config.ROOT / "Engine" / "schema" / "simulation-tables.sql"
_EVENT_TEST_CAPTURES_SQL = config.ROOT / "Engine" / "schema" / "event-test-captures-table.sql"
_AUDIT_LOG_TABLE_SQL = config.ROOT / "Engine" / "schema" / "audit-log-table.sql"


def _create_table_from_ddl(conn: sqlite3.Connection, table: str, ddl_path) -> bool:
    """Create *table* from its DDL file when missing; True when it already existed."""
    if sqlite_util.table_exists(conn, table):
        return True
    conn.executescript(ddl_path.read_text(encoding="utf-8"))
    conn.commit()
    return False


def _ensure_regex_table(conn: sqlite3.Connection) -> None:
    """Create regex table and seed default patterns on legacy catalog databases."""
    _create_table_from_ddl(conn, "regex", _REGEX_TABLE_SQL)


def _ensure_state_table(conn: sqlite3.Connection) -> None:
    """Create state table and migrate status CHECK / result column on legacy catalogs."""
    existed = _create_table_from_ddl(conn, "state", _STATE_TABLE_SQL)
    if existed:
        _rebuild_state_status_check(conn)
    sqlite_util.ensure_column(conn, "state", "run_start_date", "TEXT", commit=False)
    sqlite_util.ensure_column(conn, "state", "progress", "TEXT", commit=False)
    sqlite_util.ensure_column(conn, "state", "result", "TEXT", commit=False)
    conn.commit()


def _rebuild_state_status_check(conn: sqlite3.Connection) -> None:
    """Rebuild ``state`` when its status CHECK predates waiting/cancelled.

    SQLite cannot alter a CHECK constraint in place (same pattern as audit_log).
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'state'"
    ).fetchone()
    if row is None or "'waiting'" in (row[0] or ""):
        return
    old_cols = [r[1] for r in conn.execute("PRAGMA table_info(state)").fetchall()]
    conn.execute("ALTER TABLE state RENAME TO state_legacy")
    conn.executescript(_STATE_TABLE_SQL.read_text(encoding="utf-8"))
    new_cols = {r[1] for r in conn.execute("PRAGMA table_info(state)").fetchall()}
    copy_cols = ", ".join(c for c in old_cols if c in new_cols)
    conn.execute(f"INSERT INTO state ({copy_cols}) SELECT {copy_cols} FROM state_legacy")
    conn.execute("DROP TABLE state_legacy")
    conn.commit()


def _ensure_events_table(conn: sqlite3.Connection) -> None:
    """Create the events table on legacy catalog databases (and add later columns)."""
    existed = _create_table_from_ddl(conn, "events", _EVENTS_TABLE_SQL)
    if not existed:
        return
    sqlite_util.ensure_column(
        conn, "events", "external_package", "TEXT NOT NULL DEFAULT '{}'"
    )
    sqlite_util.ensure_column(
        conn, "events", "simulation_package", "TEXT NOT NULL DEFAULT '{}'"
    )
    _ensure_events_nav_columns(conn)
    _rebuild_events_type_check(conn)


def _rebuild_events_type_check(conn: sqlite3.Connection) -> None:
    """Rebuild ``events`` when its type CHECK predates ``simulated``.

    SQLite cannot alter a CHECK constraint in place. Same rename/copy pattern as
    ``audit_log``. Fresh catalogs created from the current DDL already allow
    ``simulated`` and are left alone.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'"
    ).fetchone()
    if row is None or "'simulated'" in (row[0] or ""):
        return
    old_cols = [r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()]
    conn.execute("ALTER TABLE events RENAME TO events_legacy")
    conn.execute("DROP INDEX IF EXISTS idx_events_space")
    conn.executescript(_EVENTS_TABLE_SQL.read_text(encoding="utf-8"))
    new_cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
    copy_cols = ", ".join(c for c in old_cols if c in new_cols)
    if copy_cols:
        conn.execute(
            f"INSERT INTO events ({copy_cols}) SELECT {copy_cols} FROM events_legacy"
        )
    conn.execute("DROP TABLE events_legacy")
    conn.commit()


def _ensure_events_nav_columns(conn: sqlite3.Connection) -> None:
    """Additive migration: nav group title and sort order on events."""
    sqlite_util.ensure_column(conn, "events", "group_title", "TEXT", commit=False)
    sqlite_util.ensure_column(conn, "events", "sort_order", "INTEGER", commit=False)
    conn.commit()


def _ensure_consoles_nav_columns(conn: sqlite3.Connection) -> None:
    """Additive migration: nav group title and sort order on consoles."""
    sqlite_util.ensure_column(conn, "consoles", "group_title", "TEXT", commit=False)
    sqlite_util.ensure_column(conn, "consoles", "sort_order", "INTEGER", commit=False)
    conn.commit()


def _ensure_consoles_table(conn: sqlite3.Connection) -> None:
    """Create the consoles table when this catalog predates it."""
    _create_table_from_ddl(conn, "consoles", _CONSOLES_TABLE_SQL)
    if sqlite_util.table_exists(conn, "consoles"):
        _ensure_consoles_nav_columns(conn)


def _ensure_simulation_tables(conn: sqlite3.Connection) -> None:
    """Create simulation session/emission tables when this catalog predates them."""
    if not (
        sqlite_util.table_exists(conn, "simulation_sessions")
        and sqlite_util.table_exists(conn, "simulation_emissions")
    ):
        conn.executescript(_SIMULATION_TABLES_SQL.read_text(encoding="utf-8"))
        conn.commit()
    sqlite_util.ensure_column(conn, "simulation_sessions", "name", "TEXT")


def _ensure_event_test_captures(conn: sqlite3.Connection) -> None:
    """Create the external-event test-payload table when this catalog predates it."""
    if sqlite_util.table_exists(conn, "event_test_captures"):
        return
    conn.executescript(_EVENT_TEST_CAPTURES_SQL.read_text(encoding="utf-8"))
    conn.commit()


def _ensure_audit_log_table(conn: sqlite3.Connection) -> None:
    """Create the audit_log table (and add later columns) on legacy catalog databases."""
    if not _create_table_from_ddl(conn, "audit_log", _AUDIT_LOG_TABLE_SQL):
        return
    sqlite_util.ensure_column(conn, "audit_log", "principal_id", "TEXT")
    sqlite_util.ensure_column(conn, "audit_log", "detail", "TEXT")
    sqlite_util.ensure_column(conn, "audit_log", "parameter_map", "TEXT")


# Catalog DB paths whose lazy table ensures already ran in this process. Startup
# migrations (migrations.run_startup_migrations) normally bring the schema current;
# the lazy path remains so any entrypoint (tests, tools) can open a fresh catalog,
# but it only pays the PRAGMA/DDL cost once per database rather than on every connect.
_ensured_catalog_paths: set[str] = set()


def catalog_conn() -> sqlite3.Connection:
    """Open catalog DB, ensuring required tables exist (once per DB path per process)."""
    path = str(config.catalog_sqlite_path())
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    if path not in _ensured_catalog_paths:
        _ensure_regex_table(conn)
        _ensure_state_table(conn)
        _ensure_events_table(conn)
        _ensure_consoles_table(conn)
        _ensure_event_test_captures(conn)
        _ensure_simulation_tables(conn)
        _ensure_audit_log_table(conn)
        spaces.ensure_catalog_space_schema(conn)
        _ensured_catalog_paths.add(path)
    return conn


@contextmanager
def catalog_connection() -> Iterator[sqlite3.Connection]:
    """Context-managed :func:`catalog_conn`.

    Closes the connection on exit; uncommitted writes are implicitly rolled back by
    the close, so write paths only need an explicit ``conn.commit()`` on success.
    """
    conn = catalog_conn()
    try:
        yield conn
    finally:
        conn.close()  # the sole explicit close; all other call sites use this manager


def list_regex_patterns() -> list[dict[str, Any]]:
    """All string-format validation patterns, ordered by name.

    Served by the authenticated ``/api/regex`` route so builder users do not need the
    instance-admin ``/api/db/*`` editor to load format options.
    """
    with catalog_connection() as conn:
        cur = conn.execute("SELECT name, regex FROM regex ORDER BY name")
        return [{"name": row[0], "regex": row[1]} for row in cur.fetchall()]


def add_regex_pattern(name: str, regex: str) -> dict[str, Any]:
    """Insert or replace a named validation pattern. The pattern must compile."""
    nm = (name or "").strip()
    if not nm:
        raise ValueError("name is required")
    pattern = regex if isinstance(regex, str) else ""
    try:
        re.compile(pattern)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern: {e}")
    with catalog_connection() as conn:
        conn.execute(
            "INSERT INTO regex (name, regex) VALUES (?, ?) "
            "ON CONFLICT(name) DO UPDATE SET regex = excluded.regex",
            (nm, pattern),
        )
        conn.commit()
        return {"name": nm, "regex": pattern}


def list_user_tables(conn: sqlite3.Connection) -> list[str]:
    cur = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
        "ORDER BY name"
    )
    return [row[0] for row in cur.fetchall()]


def table_columns(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    cur = conn.execute(f'PRAGMA table_info("{table}")')
    cols: list[dict[str, Any]] = []
    for row in cur.fetchall():
        cols.append(
            {
                "name": row[1],
                "type": row[2] or "TEXT",
                "notnull": bool(row[3]),
                "default": row[4],
                "pk": bool(row[5]),
            }
        )
    return cols


def table_primary_keys(columns: list[dict[str, Any]]) -> list[str]:
    pks = [c["name"] for c in columns if c["pk"]]
    if pks:
        return pks
    if columns:
        return [columns[0]["name"]]
    return []


def validate_table_name(conn: sqlite3.Connection, table: str) -> str:
    name = (table or "").strip()
    if not name or name not in list_user_tables(conn):
        raise ValueError(f"Unknown table: {table!r}")
    return name


def db_meta_payload() -> dict[str, Any]:
    """Schema metadata for GET /api/db/meta (db editor table picker)."""
    with catalog_connection() as conn:
        tables = []
        for name in list_user_tables(conn):
            columns = table_columns(conn, name)
            tables.append(
                {
                    "name": name,
                    "columns": columns,
                    "primary_key": table_primary_keys(columns),
                }
            )
        return {
            "database_path": str(config.catalog_sqlite_path()),
            "catalog_sqlite_env_key": config.catalog_sqlite_env_key(),
            "tables": tables,
        }


def db_fetch_rows(
    table: str, limit: int = 500, offset: int = 0
) -> dict[str, Any]:
    limit = max(1, min(limit, 2000))
    offset = max(0, offset)
    with catalog_connection() as conn:
        table = validate_table_name(conn, table)
        columns = table_columns(conn, table)
        col_names = [c["name"] for c in columns]
        quoted_cols = ", ".join(f'"{c}"' for c in col_names)
        cur = conn.execute(
            f'SELECT {quoted_cols} FROM "{table}" ORDER BY rowid LIMIT ? OFFSET ?',
            (limit, offset),
        )
        rows = [dict(zip(col_names, row)) for row in cur.fetchall()]
        count_cur = conn.execute(f'SELECT COUNT(*) FROM "{table}"')
        total = int(count_cur.fetchone()[0])
        return {
            "table": table,
            "columns": columns,
            "primary_key": table_primary_keys(columns),
            "rows": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
        }


def _row_values_for_write(
    columns: list[dict[str, Any]], values: dict[str, Any], *, for_insert: bool
) -> dict[str, Any]:
    allowed = {c["name"] for c in columns}
    out: dict[str, Any] = {}
    for key, val in values.items():
        if key not in allowed:
            continue
        if val is None or (isinstance(val, str) and not val.strip()):
            col = next(c for c in columns if c["name"] == key)
            if for_insert and col["default"] is not None:
                continue
            if col["notnull"] and col["default"] is None:
                raise ValueError(f"Column {key!r} cannot be empty")
            out[key] = None
        else:
            out[key] = val if not isinstance(val, str) else val.strip()
    return out


def db_insert_row(table: str, values: dict[str, Any]) -> dict[str, Any]:
    with catalog_connection() as conn:
        table = validate_table_name(conn, table)
        columns = table_columns(conn, table)
        row = _row_values_for_write(columns, values, for_insert=True)
        if not row:
            raise ValueError("No column values provided")
        keys = list(row.keys())
        placeholders = ", ".join("?" for _ in keys)
        quoted = ", ".join(f'"{k}"' for k in keys)
        sql = f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})'
        cur = conn.execute(sql, [row[k] for k in keys])
        conn.commit()
        return {"table": table, "rowcount": cur.rowcount, "values": row}


def db_update_row(
    table: str, pk_values: dict[str, Any], values: dict[str, Any]
) -> dict[str, Any]:
    with catalog_connection() as conn:
        table = validate_table_name(conn, table)
        columns = table_columns(conn, table)
        pk_cols = table_primary_keys(columns)
        if not all(k in pk_values for k in pk_cols):
            raise ValueError(f"Primary key fields required: {pk_cols}")
        row = _row_values_for_write(columns, values, for_insert=False)
        row = {k: v for k, v in row.items() if k not in pk_cols}
        if not row:
            raise ValueError("No updatable column values provided")
        set_clause = ", ".join(f'"{k}" = ?' for k in row)
        where_clause = " AND ".join(f'"{k}" = ?' for k in pk_cols)
        params = [row[k] for k in row] + [pk_values[k] for k in pk_cols]
        sql = f'UPDATE "{table}" SET {set_clause} WHERE {where_clause}'
        cur = conn.execute(sql, params)
        conn.commit()
        return {
            "table": table,
            "rowcount": cur.rowcount,
            "pk": {k: pk_values[k] for k in pk_cols},
            "values": row,
        }


def db_delete_row(table: str, pk_values: dict[str, Any]) -> dict[str, Any]:
    with catalog_connection() as conn:
        table = validate_table_name(conn, table)
        columns = table_columns(conn, table)
        pk_cols = table_primary_keys(columns)
        if not all(k in pk_values for k in pk_cols):
            raise ValueError(f"Primary key fields required: {pk_cols}")
        where_clause = " AND ".join(f'"{k}" = ?' for k in pk_cols)
        params = [pk_values[k] for k in pk_cols]
        sql = f'DELETE FROM "{table}" WHERE {where_clause}'
        cur = conn.execute(sql, params)
        conn.commit()
        return {
            "table": table,
            "rowcount": cur.rowcount,
            "pk": {k: pk_values[k] for k in pk_cols},
        }


def fetch_saved_queries() -> list[dict[str, Any]]:
    """List query rows used by STEP query pickers (GET /api/queries)."""
    with catalog_connection() as conn:
        tables = list_user_tables(conn)
        if "queries" not in tables:
            return []
        _ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id, name, kind, operation, runtime_enabled, author_selectable, group_title, cypher, sort_order, description, suspended "
            "FROM queries ORDER BY sort_order IS NULL, sort_order ASC, name ASC, id ASC"
        )
        rows: list[dict[str, Any]] = []
        for row in cur.fetchall():
            try:
                cypher = json.loads(row[7] or "[]")
            except json.JSONDecodeError:
                cypher = []
            kind = row[2]
            rows.append(
                {
                    "id": row[0],
                    "name": row[1],
                    "kind": kind,
                    "operation": row[3],
                    "runtime_enabled": int(row[4] or 0),
                    "author_selectable": int(row[5] or 0),
                    "group_title": row[6],
                    "cypher": cypher,
                    "sort_order": row[8],
                    "description": row[9] or "",
                    "suspended": int(row[10] or 0),
                    "single_step": (kind or "") == "sequence"
                    and not cypher_utils.cypher_has_step_hop(cypher),
                }
            )
        return rows


def fetch_query_package(query_id: str) -> dict[str, Any] | None:
    """Load one catalog query row including composed cypher/sqlite arrays."""
    qid = (query_id or "").strip()
    if not qid:
        return None
    with catalog_connection() as conn:
        _ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id, name, kind, operation, cypher, sqlite, parameters, builder_config, "
            "description, loop_config, group_title "
            "FROM queries WHERE id = ?",
            (qid,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        try:
            return {
                "id": row[0],
                "name": row[1],
                "kind": row[2] or "operation",
                "operation": row[3] or "read",
                "cypher": json.loads(row[4] or "[]"),
                "sqlite": json.loads(row[5] or "[]"),
                "parameters": json.loads(row[6] or "[]"),
                "builder_config": json.loads(row[7] or "{}"),
                "description": row[8] or "",
                "loop_config": json.loads(row[9] or "{}"),
                "group_title": row[10] or "",
            }
        except json.JSONDecodeError:
            return None


def fetch_query_for_compose(query_id: str) -> dict[str, Any] | None:
    """Load a query row's kind/operation/cypher/parameters/loop_config for composition.

    ``builder_config`` comes along because a sequence's declared walk — which STEPs and
    which POINTS_TO edges — is only fully described there; the composed ``cypher`` names
    the entry step but cannot be scoped from without re-parsing (see sequence_scope).
    """
    qid = (query_id or "").strip()
    if not qid:
        return None
    with catalog_connection() as conn:
        _ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id, name, kind, operation, cypher, parameters, runtime_enabled, triggerable, "
            "suspended, loop_config, builder_config FROM queries WHERE id = ?",
            (qid,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        try:
            loop_config = json.loads(row[9] or "{}")
            builder_config = json.loads(row[10] or "{}")
            return {
                "id": row[0],
                "name": row[1],
                "kind": (row[2] or "operation"),
                "operation": (row[3] or "read"),
                "cypher": json.loads(row[4] or "[]"),
                "parameters": json.loads(row[5] or "[]"),
                "runtime_enabled": int(row[6] if row[6] is not None else 1),
                "triggerable": int(row[7] if row[7] is not None else 1),
                "suspended": int(row[8] if row[8] is not None else 0),
                "loop_config": loop_config if isinstance(loop_config, dict) else {},
                "builder_config": builder_config if isinstance(builder_config, dict) else {},
            }
        except json.JSONDecodeError:
            return None


def find_query_by_name(name: str) -> dict[str, Any] | None:
    """A catalog query with this name. A sequence wins over an operation with the same name."""
    token = (name or "").strip()
    if not token:
        return None
    with catalog_connection() as conn:
        row = conn.execute(
            """
            SELECT id FROM queries
            WHERE name = ?
            ORDER BY CASE kind WHEN 'sequence' THEN 0 WHEN 'operation' THEN 1 ELSE 2 END, id
            LIMIT 1
            """,
            (token,),
        ).fetchone()
    if row is None:
        return None
    return fetch_query_for_compose(str(row[0]))


def insert_state_package(
    package: dict[str, Any], status: str = "inactive", run_start_date: str | None = None
) -> str:
    """Insert an EXECUTION package into the ``state`` table; return the generated UID."""
    state_id = config.generate_entity_id()
    status_val = status if status in _STATE_STATUSES else "inactive"
    with catalog_connection() as conn:
        conn.execute(
            "INSERT INTO state (id, package, status, run_start_date) VALUES (?, ?, ?, ?)",
            (state_id, json.dumps(package), status_val, run_start_date),
        )
        conn.commit()
        return state_id


def fetch_state_package(state_id: str) -> dict[str, Any] | None:
    """Load a ``state`` row (id, package, status, run_start_date, progress, result)."""
    sid = (state_id or "").strip()
    if not sid:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            "SELECT id, package, status, run_start_date, progress, result FROM state WHERE id = ?",
            (sid,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        try:
            package = json.loads(row[1] or "{}")
        except json.JSONDecodeError:
            package = {}
        try:
            progress = json.loads(row[4]) if row[4] else None
        except json.JSONDecodeError:
            progress = None
        try:
            result = json.loads(row[5]) if row[5] else None
        except (json.JSONDecodeError, IndexError):
            result = None
        return {
            "id": row[0],
            "package": package,
            "status": row[2],
            "run_start_date": row[3],
            "progress": progress,
            "result": result,
        }


def update_state_progress(state_id: str, progress: dict[str, Any] | None) -> None:
    """Persist the executor's resume progress (cursor queue + resolved values)."""
    sid = (state_id or "").strip()
    if not sid:
        return
    with catalog_connection() as conn:
        conn.execute(
            "UPDATE state SET progress = ? WHERE id = ?",
            (json.dumps(progress) if progress is not None else None, sid),
        )
        conn.commit()


def update_state_result(state_id: str, result: dict[str, Any] | None) -> None:
    """Persist the completion payload so a background resume can be polled."""
    sid = (state_id or "").strip()
    if not sid:
        return
    with catalog_connection() as conn:
        conn.execute(
            "UPDATE state SET result = ? WHERE id = ?",
            (json.dumps(result) if result is not None else None, sid),
        )
        conn.commit()


def state_cancel_requested(state_id: str) -> bool:
    """True when Stop was requested on an in-flight run."""
    row = fetch_state_package(state_id)
    if not row:
        return False
    if row.get("status") == "cancelled":
        return True
    progress = row.get("progress") or {}
    return bool(isinstance(progress, dict) and progress.get("cancel_requested"))


def request_state_cancel(state_id: str) -> dict[str, Any]:
    """Stop an in-flight run.

    Parked runs (waiting, pending) and active runs are marked cancelled immediately.
    A live runner also notices the cancelled status between steps. Marking an active
    run here is what stops a run whose worker already died inside a step.
    """
    row = fetch_state_package(state_id)
    if not row:
        return {"status": "error", "message": "state not found", "state_id": state_id}
    status = str(row.get("status") or "")
    sid = str(row.get("id") or state_id)
    if status in ("waiting", "pending", "active"):
        payload = {
            "status": "cancelled",
            "state_id": sid,
            "message": "Sequence stopped.",
        }
        update_state_result(sid, payload)
        update_state_progress(sid, None)
        update_state_status(sid, "cancelled")
        return payload
    if status == "cancelled":
        return {"status": "cancelled", "state_id": sid, "message": "Sequence stopped."}
    return {"status": status or "inactive", "state_id": sid}


def _decode_state_row(row: Any) -> dict[str, Any]:
    try:
        package = json.loads(row[1] or "{}")
    except json.JSONDecodeError:
        package = {}
    try:
        progress = json.loads(row[4]) if row[4] else None
    except json.JSONDecodeError:
        progress = None
    result = None
    if len(row) > 5 and row[5]:
        try:
            result = json.loads(row[5])
        except json.JSONDecodeError:
            result = None
    return {
        "id": row[0],
        "package": package if isinstance(package, dict) else {},
        "status": row[2],
        "run_start_date": row[3],
        "progress": progress,
        "result": result,
    }


def list_in_flight_states(space_id: str) -> list[dict[str, Any]]:
    """Active, pending, and waiting runs in a space (for the nav spinner / Stop)."""
    sid = (space_id or "").strip()
    if not sid:
        return []
    placeholders = ", ".join("?" * len(_IN_FLIGHT_STATUSES))
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT id, package, status, run_start_date, progress, result FROM state "
            f"WHERE status IN ({placeholders})",
            _IN_FLIGHT_STATUSES,
        )
        rows = [_decode_state_row(r) for r in cur.fetchall()]
    out: list[dict[str, Any]] = []
    for row in rows:
        package = row.get("package") or {}
        if str(package.get("space_id") or "").strip() != sid:
            continue
        progress = row.get("progress") if isinstance(row.get("progress"), dict) else {}
        wait = progress.get("wait") if isinstance((progress or {}).get("wait"), dict) else {}
        out.append(
            {
                "state_id": row["id"],
                "sequence_id": str(package.get("sequence_query_id") or "").strip(),
                "status": row["status"],
                "reason": str(wait.get("kind") or "") or None,
                "wake_at": wait.get("until"),
                "event_id": wait.get("event_id"),
                "step_id": (progress or {}).get("queue", [None])[0]
                if isinstance((progress or {}).get("queue"), list) and progress.get("queue")
                else None,
            }
        )
    return out


def list_waiting_states() -> list[dict[str, Any]]:
    """Every waiting run (scheduler tick)."""
    with catalog_connection() as conn:
        cur = conn.execute(
            "SELECT id, package, status, run_start_date, progress, result FROM state "
            "WHERE status = 'waiting'"
        )
        return [_decode_state_row(r) for r in cur.fetchall()]


def list_waiting_for_event(event_id: str) -> list[dict[str, Any]]:
    """Waiting runs parked on a given catalog event id."""
    eid = (event_id or "").strip()
    if not eid:
        return []
    out: list[dict[str, Any]] = []
    for row in list_waiting_states():
        progress = row.get("progress") if isinstance(row.get("progress"), dict) else {}
        wait = progress.get("wait") if isinstance((progress or {}).get("wait"), dict) else {}
        if str(wait.get("event_id") or "").strip() == eid:
            out.append(row)
    return out


def update_state_status(
    state_id: str, status: str, run_start_date: str | None = None, set_run_start: bool = False
) -> None:
    """Update a ``state`` row's status, optionally setting run_start_date."""
    sid = (state_id or "").strip()
    if not sid:
        return
    status_val = status if status in _STATE_STATUSES else "inactive"
    with catalog_connection() as conn:
        if set_run_start:
            conn.execute(
                "UPDATE state SET status = ?, run_start_date = ? WHERE id = ?",
                (status_val, run_start_date, sid),
            )
        else:
            conn.execute(
                "UPDATE state SET status = ? WHERE id = ?",
                (status_val, sid),
            )
        conn.commit()


def delete_unrun_state_packages(
    sequence_query_id: str, owner_id: str | None = None, space_id: str | None = None
) -> int:
    """Delete composed-but-unrun ``state`` packages for a sequence; return count removed.

    "Unrun" means status ``inactive`` with no ``run_start_date`` — a package that
    was composed but never executed. Re-composing the same sequence for the same
    owner (and space) can replace the prior package with this, instead of leaving
    abandoned packages to pile up in the ``state`` table.     Packages that have run (``run_start_date`` set) or are in-flight
    (``active`` / ``pending`` / ``waiting``) are never touched. ``owner_id`` / ``space_id`` further scope the match so one client's
    re-compose can't drop another client's pending package.
    """
    seq = (sequence_query_id or "").strip()
    if not seq:
        return 0
    clauses = [
        "status = 'inactive'",
        "run_start_date IS NULL",
        "json_extract(package, '$.sequence_query_id') = ?",
    ]
    args: list[Any] = [seq]
    oid = (owner_id or "").strip()
    if oid:
        clauses.append("json_extract(package, '$.owner_id') = ?")
        args.append(oid)
    sid = (space_id or "").strip()
    if sid:
        clauses.append("json_extract(package, '$.space_id') = ?")
        args.append(sid)
    with catalog_connection() as conn:
        cur = conn.execute(f"DELETE FROM state WHERE {' AND '.join(clauses)}", args)
        conn.commit()
        return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


def purge_finished_state_packages(exclude_id: str | None = None) -> int:
    """Delete stale finished run packages; keep the latest per sequence.

    Finished means ``inactive`` or ``cancelled`` with a ``run_start_date``. Rows
    still needed are preserved:

      - composed-but-unrun packages (``run_start_date`` NULL);
      - in-flight runs (``active`` / ``pending`` / ``waiting``);
      - the latest finished row per (sequence, owner, space), so the UI can poll
        a background wait's result;
      - ``exclude_id`` when supplied.
    """
    with catalog_connection() as conn:
        cur = conn.execute(
            "SELECT id, package, status, run_start_date FROM state "
            "WHERE status IN ('inactive', 'cancelled') AND run_start_date IS NOT NULL"
        )
        groups: dict[tuple[str, str, str], list[tuple[str, str]]] = {}
        for row in cur.fetchall():
            try:
                package = json.loads(row[1] or "{}")
            except json.JSONDecodeError:
                package = {}
            key = (
                str((package or {}).get("sequence_query_id") or "").strip(),
                str((package or {}).get("owner_id") or "").strip(),
                str((package or {}).get("space_id") or "").strip(),
            )
            groups.setdefault(key, []).append((row[0], str(row[3] or "")))
        keep: set[str] = set()
        eid = (exclude_id or "").strip()
        if eid:
            keep.add(eid)
        delete_ids: list[str] = []
        for rows in groups.values():
            rows_sorted = sorted(rows, key=lambda item: item[1], reverse=True)
            latest_id = rows_sorted[0][0] if rows_sorted else ""
            if latest_id:
                keep.add(latest_id)
            for row_id, _ in rows_sorted:
                if row_id not in keep:
                    delete_ids.append(row_id)
        if not delete_ids:
            return 0
        placeholders = ", ".join("?" * len(delete_ids))
        cur = conn.execute(f"DELETE FROM state WHERE id IN ({placeholders})", delete_ids)
        conn.commit()
        return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0


# ---------------------------------------------------------------------------
# Events (triggers) + audit log
# ---------------------------------------------------------------------------


def _json_loads_or(value: Any, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback


def _event_row_to_dict(row: sqlite3.Row | tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "space_id": row[1],
        "name": row[2],
        "type": row[3],
        "enabled": int(row[4] if row[4] is not None else 1),
        "event_package": _json_loads_or(row[5], {}),
        "external_package": _json_loads_or(row[6], {}),
        "sequences": _json_loads_or(row[7], []),
        "timers": _json_loads_or(row[8], {}),
        "recovery_sequences": _json_loads_or(row[9], []),
        "creation_date": row[10],
        "modified_date": row[11],
        "simulation_package": _json_loads_or(row[12], {}) if len(row) > 12 else {},
        "group_title": (str(row[13]).strip() or None) if len(row) > 13 and row[13] else None,
        "sort_order": int(row[14]) if len(row) > 14 and row[14] is not None else None,
    }


_EVENT_COLUMNS = (
    "id, space_id, name, type, enabled, event_package, external_package, sequences, "
    "timers, recovery_sequences, creation_date, modified_date, simulation_package, "
    "group_title, sort_order"
)

_NAV_LIST_ORDER = "ORDER BY sort_order IS NULL, sort_order ASC, name ASC, id ASC"


def list_events(space_id: str | None = None) -> list[dict[str, Any]]:
    """List event rows, optionally filtered to a single space."""
    with catalog_connection() as conn:
        if space_id:
            cur = conn.execute(
                f"SELECT {_EVENT_COLUMNS} FROM events WHERE space_id = ? {_NAV_LIST_ORDER}",
                (space_id,),
            )
        else:
            cur = conn.execute(
                f"SELECT {_EVENT_COLUMNS} FROM events {_NAV_LIST_ORDER}"
            )
        return [_event_row_to_dict(row) for row in cur.fetchall()]


def get_event(event_id: str) -> dict[str, Any] | None:
    """Load one event row, or None when missing."""
    eid = (event_id or "").strip()
    if not eid:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_EVENT_COLUMNS} FROM events WHERE id = ?", (eid,)
        )
        row = cur.fetchone()
        return _event_row_to_dict(row) if row is not None else None


def upsert_event(
    event_id: str,
    space_id: str,
    name: str,
    event_package: dict[str, Any] | None,
    sequences: list[str] | None,
    recovery_sequences: list[str] | None,
    type: str = "time",
    enabled: int = 1,
    timers: dict[str, Any] | None = None,
    external_package: dict[str, Any] | None = None,
    simulation_package: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Insert or update an event row. ``timers`` is preserved on update when None;
    ``external_package`` and ``simulation_package`` are preserved on update when None."""
    eid = (event_id or "").strip()
    if not eid:
        raise ValueError("event id is required")
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    name_val = (name or "").strip()
    if not name_val:
        raise ValueError("event name is required")
    type_val = (type or "time").strip().lower()
    if type_val not in ("time", "external", "simulated"):
        type_val = "time"
    enabled_int = 1 if enabled else 0
    package_json = json.dumps(event_package if isinstance(event_package, dict) else {})
    sequences_json = json.dumps([str(s) for s in (sequences or []) if str(s).strip()])
    recovery_json = json.dumps(
        [str(s) for s in (recovery_sequences or []) if str(s).strip()]
    )
    with catalog_connection() as conn:
        if timers is None:
            cur = conn.execute("SELECT timers FROM events WHERE id = ?", (eid,))
            existing = cur.fetchone()
            timers_json = (existing[0] if existing and existing[0] else "{}")
        else:
            timers_json = json.dumps(timers)
        if external_package is None:
            cur = conn.execute(
                "SELECT external_package FROM events WHERE id = ?", (eid,)
            )
            existing = cur.fetchone()
            external_json = (existing[0] if existing and existing[0] else "{}")
        else:
            external_json = json.dumps(external_package)
        if simulation_package is None:
            cur = conn.execute(
                "SELECT simulation_package FROM events WHERE id = ?", (eid,)
            )
            existing = cur.fetchone()
            simulation_json = (existing[0] if existing and existing[0] else "{}")
        else:
            simulation_json = json.dumps(simulation_package)
        conn.execute(
            """
            INSERT INTO events (
              id, space_id, name, type, enabled, event_package, external_package,
              sequences, timers, recovery_sequences, creation_date, modified_date,
              simulation_package
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
            ON CONFLICT(id) DO UPDATE SET
              space_id = excluded.space_id,
              name = excluded.name,
              type = excluded.type,
              enabled = excluded.enabled,
              event_package = excluded.event_package,
              external_package = excluded.external_package,
              sequences = excluded.sequences,
              timers = excluded.timers,
              recovery_sequences = excluded.recovery_sequences,
              simulation_package = excluded.simulation_package,
              modified_date = datetime('now')
            """,
            (
                eid,
                sid,
                name_val,
                type_val,
                enabled_int,
                package_json,
                external_json,
                sequences_json,
                timers_json,
                recovery_json,
                simulation_json,
            ),
        )
        conn.commit()
        return {"id": eid}


def get_event_by_ingest_token(token: str) -> dict[str, Any] | None:
    """Resolve an external event by the ingest token embedded in its inbound URL.

    Used by the unauthenticated ``/api/hooks/{ingest_token}`` receiver. Tokens are
    high-entropy and unique per external event, so they act as the URL's secret. Only
    ``type = 'external'`` rows carry a token. Returns None when no event matches.
    """
    tok = (token or "").strip()
    if not tok:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_EVENT_COLUMNS} FROM events WHERE type = 'external'"
        )
        for row in cur.fetchall():
            event = _event_row_to_dict(row)
            pkg = event.get("external_package") or {}
            if isinstance(pkg, dict) and str(pkg.get("ingest_token") or "") == tok:
                return event
        return None


def get_event_by_simulation_token(token: str) -> dict[str, Any] | None:
    """Resolve a simulated event by the public session-control token.

    Used by the unauthenticated ``/api/sim/{token}`` routes. Tokens are high-entropy
    and stored on ``simulation_package``. Returns None when no event matches.
    """
    tok = (token or "").strip()
    if not tok:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_EVENT_COLUMNS} FROM events WHERE type = 'simulated'"
        )
        for row in cur.fetchall():
            event = _event_row_to_dict(row)
            pkg = event.get("simulation_package") or {}
            if isinstance(pkg, dict) and str(pkg.get("token") or "") == tok:
                return event
        return None


def update_event_timers(event_id: str, timers: dict[str, Any] | None) -> None:
    """Persist only the scheduler timer state (next_fire_at / last_fired_at)."""
    eid = (event_id or "").strip()
    if not eid:
        return
    with catalog_connection() as conn:
        conn.execute(
            "UPDATE events SET timers = ? WHERE id = ?",
            (json.dumps(timers if timers is not None else {}), eid),
        )
        conn.commit()


def record_event_test_capture(
    event_id: str, payload: Any, content_type: str | None = None
) -> dict[str, Any]:
    """Store the latest test-endpoint payload for an external event (replaces the previous)."""
    eid = (event_id or "").strip()
    if not eid:
        raise ValueError("event id is required")
    received_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ctype = (content_type or "").strip() or None
    if ctype and len(ctype) > 200:
        ctype = ctype[:200]
    body = json.dumps(payload if payload is not None else {})
    with catalog_connection() as conn:
        conn.execute(
            """
            INSERT INTO event_test_captures (event_id, received_at, content_type, payload)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
              received_at = excluded.received_at,
              content_type = excluded.content_type,
              payload = excluded.payload
            """,
            (eid, received_at, ctype, body),
        )
        conn.commit()
    return {
        "received_at": received_at,
        "content_type": ctype,
        "payload": payload if payload is not None else {},
    }


def latest_event_test_capture(event_id: str) -> dict[str, Any] | None:
    """The most recent test-endpoint payload for an event, or None."""
    eid = (event_id or "").strip()
    if not eid:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            "SELECT received_at, content_type, payload FROM event_test_captures WHERE event_id = ?",
            (eid,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    try:
        payload = json.loads(row[2]) if row[2] else {}
    except json.JSONDecodeError:
        payload = {"raw": row[2]}
    return {
        "received_at": row[0],
        "content_type": row[1],
        "payload": payload,
    }


def clear_event_test_capture(event_id: str) -> None:
    """Drop the stored test payload for one event."""
    eid = (event_id or "").strip()
    if not eid:
        return
    with catalog_connection() as conn:
        conn.execute("DELETE FROM event_test_captures WHERE event_id = ?", (eid,))
        conn.commit()


def _delete_simulation_for_event(conn: sqlite3.Connection, event_id: str) -> None:
    """Drop a simulated event's sessions and emissions. Caller commits."""
    if sqlite_util.table_exists(conn, "simulation_emissions"):
        conn.execute("DELETE FROM simulation_emissions WHERE event_id = ?", (event_id,))
    if sqlite_util.table_exists(conn, "simulation_sessions"):
        conn.execute("DELETE FROM simulation_sessions WHERE event_id = ?", (event_id,))


_SESSION_COLUMNS = (
    "id, event_id, space_id, status, current_tic, world_start_at, "
    "current_world_time, created_at, error_message, name"
)

_EMISSION_COLUMNS = (
    "id, session_id, event_id, space_id, probability_id, probability_name, tic, "
    "world_time, outcome_json, cancelled, sequence_id, run_status, created_at"
)


def _simulation_session_row(row: sqlite3.Row | tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "event_id": row[1],
        "space_id": row[2],
        "status": row[3],
        "current_tic": int(row[4] or 0),
        "world_start_at": row[5],
        "current_world_time": row[6],
        "created_at": row[7],
        "error_message": row[8],
        "name": row[9] or None,
    }


def _simulation_emission_row(row: sqlite3.Row | tuple) -> dict[str, Any]:
    try:
        outcome = json.loads(row[8]) if row[8] else None
    except json.JSONDecodeError:
        outcome = None
    return {
        "id": row[0],
        "session_id": row[1],
        "event_id": row[2],
        "space_id": row[3],
        "probability_id": row[4],
        "probability_name": row[5],
        "tic": int(row[6] or 0),
        "world_time": row[7],
        "outcome": outcome,
        "cancelled": bool(row[9]),
        "sequence_id": row[10],
        "run_status": row[11],
        "created_at": row[12],
    }


def list_simulation_sessions(event_id: str) -> list[dict[str, Any]]:
    """Sessions for one simulated event, newest first."""
    eid = (event_id or "").strip()
    if not eid:
        return []
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM simulation_sessions WHERE event_id = ? "
            "ORDER BY created_at DESC, id DESC",
            (eid,),
        )
        return [_simulation_session_row(row) for row in cur.fetchall()]


def get_simulation_session(session_id: str, event_id: str | None = None) -> dict[str, Any] | None:
    """One session, optionally constrained to an event. None when missing or mismatched."""
    sid = (session_id or "").strip()
    if not sid:
        return None
    eid = (event_id or "").strip()
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM simulation_sessions WHERE id = ?",
            (sid,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    session = _simulation_session_row(row)
    if eid and session["event_id"] != eid:
        return None
    return session


def list_simulation_emissions(session_id: str) -> list[dict[str, Any]]:
    """Emissions for one session, in tic order."""
    sid = (session_id or "").strip()
    if not sid:
        return []
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_EMISSION_COLUMNS} FROM simulation_emissions WHERE session_id = ? "
            "ORDER BY tic ASC, rowid ASC",
            (sid,),
        )
        return [_simulation_emission_row(row) for row in cur.fetchall()]


def get_simulation_session_detail(
    session_id: str, event_id: str | None = None
) -> dict[str, Any] | None:
    """Session plus its emissions, or None."""
    session = get_simulation_session(session_id, event_id)
    if session is None:
        return None
    return {**session, "emissions": list_simulation_emissions(session["id"])}


def insert_simulation_session(
    session_id: str,
    event_id: str,
    space_id: str,
    world_start_at: str,
    current_world_time: str,
) -> None:
    """Insert a running session at tic 0."""
    with catalog_connection() as conn:
        conn.execute(
            """
            INSERT INTO simulation_sessions (
              id, event_id, space_id, status, current_tic, world_start_at,
              current_world_time, created_at, error_message
            )
            VALUES (?, ?, ?, 'running', 0, ?, ?, datetime('now'), NULL)
            """,
            (session_id, event_id, space_id, world_start_at, current_world_time),
        )
        conn.commit()


def update_simulation_session(
    session_id: str,
    *,
    status: str | None = None,
    current_tic: int | None = None,
    current_world_time: str | None = None,
    error_message: str | None = None,
    clear_error: bool = False,
    name: str | None = None,
    clear_name: bool = False,
) -> None:
    """Patch session clock/status. ``clear_error`` nulls ``error_message``.

    ``name`` stores a caller-chosen label. ``clear_name`` nulls it so the
    session is addressed by its start time again.
    """
    sid = (session_id or "").strip()
    if not sid:
        return
    sets: list[str] = []
    params: list[Any] = []
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if current_tic is not None:
        sets.append("current_tic = ?")
        params.append(int(current_tic))
    if current_world_time is not None:
        sets.append("current_world_time = ?")
        params.append(current_world_time)
    if clear_error:
        sets.append("error_message = NULL")
    elif error_message is not None:
        sets.append("error_message = ?")
        params.append(error_message)
    if clear_name:
        sets.append("name = NULL")
    elif name is not None:
        sets.append("name = ?")
        params.append(name)
    if not sets:
        return
    params.append(sid)
    with catalog_connection() as conn:
        conn.execute(
            f"UPDATE simulation_sessions SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        conn.commit()


def delete_simulation_session(session_id: str, event_id: str) -> bool:
    """Delete one session and its emissions. False when it is not on this event."""
    sid = (session_id or "").strip()
    eid = (event_id or "").strip()
    if not sid or not eid:
        return False
    with catalog_connection() as conn:
        cur = conn.execute(
            "SELECT 1 FROM simulation_sessions WHERE id = ? AND event_id = ?",
            (sid, eid),
        )
        if cur.fetchone() is None:
            return False
        conn.execute("DELETE FROM simulation_emissions WHERE session_id = ?", (sid,))
        conn.execute(
            "DELETE FROM simulation_sessions WHERE id = ? AND event_id = ?",
            (sid, eid),
        )
        conn.commit()
        return True


def insert_simulation_emission(
    emission_id: str,
    session_id: str,
    event_id: str,
    space_id: str,
    probability_id: str,
    probability_name: str,
    tic: int,
    world_time: str,
    outcome: dict[str, Any] | None,
    cancelled: bool,
    sequence_id: str | None,
    run_status: str | None,
) -> None:
    """Append one emission row for a probability that ran on a tic."""
    with catalog_connection() as conn:
        conn.execute(
            """
            INSERT INTO simulation_emissions (
              id, session_id, event_id, space_id, probability_id, probability_name,
              tic, world_time, outcome_json, cancelled, sequence_id, run_status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                emission_id,
                session_id,
                event_id,
                space_id,
                probability_id,
                probability_name,
                int(tic),
                world_time,
                json.dumps(outcome) if outcome is not None else None,
                1 if cancelled else 0,
                sequence_id,
                run_status,
            ),
        )
        conn.commit()


def update_simulation_emission_status(emission_id: str, run_status: str | None) -> None:
    """Record how the emission's sequence run finished."""
    eid = (emission_id or "").strip()
    if not eid:
        return
    with catalog_connection() as conn:
        conn.execute(
            "UPDATE simulation_emissions SET run_status = ? WHERE id = ?",
            (run_status, eid),
        )
        conn.commit()


def _normalize_console_document(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    views = source.get("views")
    if not isinstance(views, list):
        views = []
    active = source.get("activeViewId")
    return {
        "views": views,
        "activeViewId": active if isinstance(active, str) else "",
    }


def _console_row_to_dict(row: sqlite3.Row | tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "space_id": row[1],
        "name": row[2],
        "trigger_kind": row[3] or "",
        "listen_url": row[4] or "",
        "trigger_event_id": row[5] or "",
        "document": _normalize_console_document(_json_loads_or(row[6], {})),
        "creation_date": row[7],
        "modified_date": row[8],
        "group_title": (str(row[9]).strip() or None) if len(row) > 9 and row[9] else None,
        "sort_order": int(row[10]) if len(row) > 10 and row[10] is not None else None,
    }


_CONSOLE_COLUMNS = (
    "id, space_id, name, trigger_kind, listen_url, trigger_event_id, document, "
    "creation_date, modified_date, group_title, sort_order"
)


def list_consoles(space_id: str | None = None) -> list[dict[str, Any]]:
    """List consoles, optionally filtered to one space."""
    with catalog_connection() as conn:
        if space_id:
            cur = conn.execute(
                f"SELECT {_CONSOLE_COLUMNS} FROM consoles WHERE space_id = ? {_NAV_LIST_ORDER}",
                (space_id,),
            )
        else:
            cur = conn.execute(
                f"SELECT {_CONSOLE_COLUMNS} FROM consoles {_NAV_LIST_ORDER}"
            )
        return [_console_row_to_dict(row) for row in cur.fetchall()]


def list_consoles_for_trigger(event_id: str) -> list[dict[str, Any]]:
    """Consoles whose trigger is this time or external event."""
    eid = (event_id or "").strip()
    if not eid:
        return []
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_CONSOLE_COLUMNS} FROM consoles "
            "WHERE trigger_kind = 'event' AND trigger_event_id = ?",
            (eid,),
        )
        return [_console_row_to_dict(row) for row in cur.fetchall()]


def get_console(console_id: str) -> dict[str, Any] | None:
    cid = (console_id or "").strip()
    if not cid:
        return None
    with catalog_connection() as conn:
        cur = conn.execute(
            f"SELECT {_CONSOLE_COLUMNS} FROM consoles WHERE id = ?", (cid,)
        )
        row = cur.fetchone()
        return _console_row_to_dict(row) if row is not None else None


def upsert_console(
    console_id: str,
    space_id: str,
    name: str,
    trigger_kind: str = "",
    listen_url: str = "",
    trigger_event_id: str = "",
    document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Insert or update a console. A trigger event must be time or external in the same space."""
    cid = (console_id or "").strip()
    if not cid:
        raise ValueError("console id is required")
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    name_val = (name or "").strip()
    if not name_val:
        raise ValueError("console name is required")
    kind = (trigger_kind or "").strip().lower()
    if kind not in ("", "url", "event"):
        raise ValueError("trigger_kind must be url or event")
    listen = (listen_url or "").strip()
    event_id = (trigger_event_id or "").strip()
    if kind == "event":
        if not event_id:
            raise ValueError("trigger_event_id is required")
        event = get_event(event_id)
        if event is None or str(event.get("space_id") or "") != sid:
            raise ValueError("trigger event was not found in this space")
        if str(event.get("type") or "") not in ("time", "external"):
            raise ValueError("a console trigger must be a time or external event")
    else:
        event_id = ""
    if kind != "url":
        listen = ""
    doc = _normalize_console_document(document if isinstance(document, dict) else {})
    with catalog_connection() as conn:
        conn.execute(
            """
            INSERT INTO consoles (
              id, space_id, name, trigger_kind, listen_url, trigger_event_id,
              document, creation_date, modified_date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              space_id = excluded.space_id,
              name = excluded.name,
              trigger_kind = excluded.trigger_kind,
              listen_url = excluded.listen_url,
              trigger_event_id = excluded.trigger_event_id,
              document = excluded.document,
              modified_date = datetime('now')
            """,
            (cid, sid, name_val, kind, listen, event_id, json.dumps(doc)),
        )
        conn.commit()
    return get_console(cid) or {"id": cid}


def delete_console(console_id: str) -> dict[str, Any]:
    """Delete a console and clear it from any simulation that pointed at it."""
    cid = (console_id or "").strip()
    if not cid:
        raise ValueError("console id is required")
    with catalog_connection() as conn:
        conn.execute(
            """
            UPDATE events
            SET simulation_package = json_set(simulation_package, '$.console_id', ''),
                modified_date = datetime('now')
            WHERE json_extract(simulation_package, '$.console_id') = ?
            """,
            (cid,),
        )
        cur = conn.execute("DELETE FROM consoles WHERE id = ?", (cid,))
        conn.commit()
        return {"id": cid, "rowcount": cur.rowcount}


def delete_event(event_id: str) -> dict[str, Any]:
    """Delete one event row and its simulation history; returns the affected row count."""
    eid = (event_id or "").strip()
    if not eid:
        raise ValueError("event id is required")
    with catalog_connection() as conn:
        conn.execute("DELETE FROM event_test_captures WHERE event_id = ?", (eid,))
        _delete_simulation_for_event(conn, eid)
        if sqlite_util.table_exists(conn, "consoles"):
            conn.execute(
                "UPDATE consoles SET trigger_event_id = '', trigger_kind = '', "
                "modified_date = datetime('now') "
                "WHERE trigger_kind = 'event' AND trigger_event_id = ?",
                (eid,),
            )
        cur = conn.execute("DELETE FROM events WHERE id = ?", (eid,))
        conn.commit()
        return {"id": eid, "rowcount": cur.rowcount}


def _parameter_map_json(parameter_map: dict[str, Any] | None) -> str | None:
    """Serialize a run's resolved parameter map. Non-dicts are omitted.

    Credential-store secrets are not part of this map; the executor resolves
    ``$secret.<NAME>`` only for the outbound call and never merges those values.
    """
    if not isinstance(parameter_map, dict):
        return None
    try:
        return json.dumps(parameter_map, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps(
            {str(key): str(value) for key, value in parameter_map.items()},
            ensure_ascii=False,
        )


def record_audit(
    space_id: str | None,
    sequence_ids: list[str],
    event_id: str | None = None,
    trigger: str = "manual",
    principal_id: str | None = None,
    detail: dict[str, Any] | None = None,
    parameter_map: dict[str, Any] | None = None,
) -> str:
    """Append an audit_log row for a sequence run; return the generated UID.

    ``principal_id`` is the principal that triggered the run (user or agent); it is
    left NULL for scheduler-fired event/recovery runs, which have no acting principal.
    ``detail`` is optional JSON context; it must never contain parameters, outputs,
    or secrets. ``parameter_map`` is the run's resolved parameter map at the moment
    the row is written (the executor updates it again as the run progresses).
    """
    audit_id = config.generate_entity_id()
    trigger_val = (
        trigger
        if trigger
        in ("manual", "event", "recovery", "webhook", "mcp", "code", "external", "simulated")
        else "manual"
    )
    ids_json = json.dumps([str(s) for s in (sequence_ids or []) if str(s).strip()])
    detail_json = json.dumps(detail) if isinstance(detail, dict) and detail else None
    parameter_map_json = _parameter_map_json(parameter_map)
    with catalog_connection() as conn:
        conn.execute(
            "INSERT INTO audit_log "
            "(id, run_at, space_id, sequence_ids, event_id, trigger, principal_id, "
            "detail, parameter_map) "
            "VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)",
            (
                audit_id,
                (space_id or "").strip() or None,
                ids_json,
                (event_id or "").strip() or None,
                trigger_val,
                (principal_id or "").strip() or None,
                detail_json,
                parameter_map_json,
            ),
        )
        conn.commit()
        return audit_id


def update_audit_parameter_map(audit_id: str, parameter_map: dict[str, Any] | None) -> None:
    """Replace the parameter map stored on an existing audit row.

    No-op when the id is blank or the map is not a dict. Audit failures must not
    break a run; callers catch exceptions around this.
    """
    aid = (audit_id or "").strip()
    payload = _parameter_map_json(parameter_map)
    if not aid or payload is None:
        return
    with catalog_connection() as conn:
        if not sqlite_util.table_exists(conn, "audit_log"):
            return
        if "parameter_map" not in sqlite_util.column_names(conn, "audit_log"):
            return
        conn.execute(
            "UPDATE audit_log SET parameter_map = ? WHERE id = ?",
            (payload, aid),
        )
        conn.commit()


def list_audit_log(space_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """List recent audit_log rows (most recent first), optionally scoped to a space.

    The acting principal is resolved to its email via a ``users`` LEFT JOIN so the UI
    can show a human-readable label; ``principal_email`` is NULL for scheduler-fired
    runs (no principal) or principals that no longer exist.
    """
    limit = max(1, min(int(limit or 200), 2000))
    with catalog_connection() as conn:
        # Legacy catalogs may predate the users table; fall back to no email join.
        has_users = (
            conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
            ).fetchone()
            is not None
        )
        email_select = "u.email" if has_users else "NULL"
        join_clause = (
            "LEFT JOIN users u ON u.id = a.principal_id" if has_users else ""
        )
        audit_cols = {
            r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()
        }
        # Legacy catalogs may predate detail / parameter_map.
        detail_select = "a.detail" if "detail" in audit_cols else "NULL"
        parameter_map_select = (
            "a.parameter_map" if "parameter_map" in audit_cols else "NULL"
        )
        if space_id:
            cur = conn.execute(
                "SELECT a.id, a.run_at, a.space_id, a.sequence_ids, a.event_id, a.trigger, "
                f"a.principal_id, {email_select}, {detail_select}, {parameter_map_select} "
                f"FROM audit_log a {join_clause} "
                "WHERE a.space_id = ? ORDER BY a.run_at DESC, a.rowid DESC LIMIT ?",
                (space_id, limit),
            )
        else:
            cur = conn.execute(
                "SELECT a.id, a.run_at, a.space_id, a.sequence_ids, a.event_id, a.trigger, "
                f"a.principal_id, {email_select}, {detail_select}, {parameter_map_select} "
                f"FROM audit_log a {join_clause} "
                "ORDER BY a.run_at DESC, a.rowid DESC LIMIT ?",
                (limit,),
            )
        rows = []
        for row in cur.fetchall():
            raw_map = _json_loads_or(row[9], None) if row[9] else None
            rows.append(
                {
                    "id": row[0],
                    "run_at": row[1],
                    "space_id": row[2],
                    "sequence_ids": _json_loads_or(row[3], []),
                    "event_id": row[4],
                    "trigger": row[5],
                    "principal_id": row[6],
                    "principal_email": row[7],
                    "detail": _json_loads_or(row[8], None) if row[8] else None,
                    "parameter_map": raw_map if isinstance(raw_map, dict) else None,
                }
            )
        return rows


def _is_queries_catalog_upsert_sql(text: str) -> bool:
    """Detect the catalog queries-table upsert (must not be stored in queries.sqlite JSON)."""
    normalized = " ".join((text or "").split())
    upper = normalized.upper()
    return upper.startswith("INSERT INTO QUERIES ") and "ON CONFLICT(ID)" in upper


def _entity_sqlite_for_catalog(sqlite: list[str]) -> list[str]:
    return [str(s) for s in sqlite if str(s).strip() and not _is_queries_catalog_upsert_sql(str(s))]


def _json_object_for_catalog(value: str | None) -> str:
    """Normalize a JSON-object column payload to a storable string.

    Accepts an already-serialized JSON string from the upsert handler; falls back to ``{}``
    when missing or not valid JSON so the table's json_valid CHECK constraint holds. Used
    for both ``builder_config`` and ``loop_config``.
    """
    raw = (value or "").strip()
    if not raw:
        return "{}"
    try:
        json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return "{}"
    return raw


# Policy / metadata columns added to the ``queries`` table over time (legacy DBs).
_QUERIES_POLICY_COLUMNS = (
    ("kind", "TEXT NOT NULL DEFAULT 'user'"),
    ("operation", "TEXT NOT NULL DEFAULT 'read'"),
    ("runtime_enabled", "INTEGER NOT NULL DEFAULT 1"),
    ("author_selectable", "INTEGER NOT NULL DEFAULT 1"),
    ("triggerable", "INTEGER NOT NULL DEFAULT 1"),
    ("suspended", "INTEGER NOT NULL DEFAULT 0"),
    ("group_title", "TEXT"),
    ("description", "TEXT NOT NULL DEFAULT ''"),
    ("sort_order", "INTEGER"),
    ("builder_config", "TEXT NOT NULL DEFAULT '{}'"),
    ("loop_config", "TEXT NOT NULL DEFAULT '{}'"),
)

# Catalog DB paths whose queries-policy columns are known current (per process).
_queries_policy_ensured: set[str] = set()


def ensure_queries_policy_columns(conn: sqlite3.Connection) -> None:
    """Add query policy columns to legacy catalog databases (once per DB path)."""
    path = str(config.catalog_sqlite_path())
    if path in _queries_policy_ensured:
        return
    changed = False
    for column, ddl in _QUERIES_POLICY_COLUMNS:
        if sqlite_util.ensure_column(conn, "queries", column, ddl, commit=False):
            changed = True
    if changed:
        conn.commit()
    if sqlite_util.table_exists(conn, "queries"):
        _queries_policy_ensured.add(path)


# Backwards-compatible alias (external callers used the private name).
_ensure_queries_policy_columns = ensure_queries_policy_columns


def _catalog_bool_to_int(
    catalog: dict[str, Any] | None, key: str, default: int = 0
) -> int:
    if not catalog:
        return 1 if default else 0
    val = catalog.get(key)
    if val is None:
        return 1 if default else 0
    if isinstance(val, bool):
        return 1 if val else 0
    if isinstance(val, (int, float)):
        return 1 if val else 0
    return 1 if str(val).lower() in ("1", "true", "yes") else 0


def queries_catalog_runtime_enabled_int(catalog: dict[str, Any] | None) -> int:
    return _catalog_bool_to_int(catalog, "runtime_enabled", default=0)


def queries_catalog_author_selectable_int(catalog: dict[str, Any] | None) -> int:
    return _catalog_bool_to_int(catalog, "author_selectable", default=1)


def queries_catalog_triggerable_int(catalog: dict[str, Any] | None) -> int:
    return _catalog_bool_to_int(catalog, "triggerable", default=1)


def upsert_queries_catalog_row(
    row_id: str,
    name: str,
    cypher: list[str],
    sqlite: list[str],
    parameters: list[Any],
    kind: str = "user",
    operation: str = "read",
    runtime_enabled: int = 0,
    author_selectable: int = 1,
    group_title: str | None = None,
    triggerable: int = 1,
    builder_config: str | None = None,
    description: str | None = None,
    loop_config: str | None = None,
) -> dict[str, Any]:
    """Insert or update a row in the catalog queries table (data.db)."""
    rid = (row_id or "").strip()
    if not rid:
        raise ValueError("queries catalog id is required")
    with catalog_connection() as conn:
        tables = list_user_tables(conn)
        if "queries" not in tables:
            raise ValueError("queries table not found in catalog database")
        _ensure_queries_policy_columns(conn)
        group_title_val = (group_title or "").strip() or None
        cypher_json = json.dumps([str(s) for s in cypher if str(s).strip()])
        sqlite_json = json.dumps(_entity_sqlite_for_catalog(sqlite))
        parameters_json = json.dumps(parameters if parameters is not None else [])
        kind_val = (kind or "user").strip().lower()
        if kind_val not in ("system", "user", "operation", "sequence"):
            kind_val = "user"
        operation_val = (operation or "read").strip().lower()
        if operation_val not in ("create", "read", "update", "delete"):
            operation_val = "read"
        runtime_enabled_int = 1 if runtime_enabled else 0
        author_selectable_int = 1 if author_selectable else 0
        triggerable_int = 1 if triggerable else 0
        builder_config_json = _json_object_for_catalog(builder_config)
        loop_config_json = _json_object_for_catalog(loop_config)
        description_val = (description or "").strip()
        cur = conn.execute(
            """
            INSERT INTO queries (
              id, name, kind, operation, runtime_enabled, author_selectable,
              triggerable, group_title, cypher, sqlite, parameters, builder_config,
              description, loop_config, creation_date, modified_date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              kind = excluded.kind,
              operation = excluded.operation,
              runtime_enabled = excluded.runtime_enabled,
              author_selectable = excluded.author_selectable,
              triggerable = excluded.triggerable,
              group_title = excluded.group_title,
              cypher = excluded.cypher,
              sqlite = excluded.sqlite,
              parameters = excluded.parameters,
              builder_config = excluded.builder_config,
              description = excluded.description,
              loop_config = excluded.loop_config,
              modified_date = datetime('now')
            """,
            (
                rid,
                (name or "").strip(),
                kind_val,
                operation_val,
                runtime_enabled_int,
                author_selectable_int,
                triggerable_int,
                group_title_val,
                cypher_json,
                sqlite_json,
                parameters_json,
                builder_config_json,
                description_val,
                loop_config_json,
            ),
        )
        conn.commit()
        return {"id": rid, "rowcount": cur.rowcount}


def update_query_description(query_id: str, description: str) -> dict[str, Any]:
    """Update only a query's ``description`` (post-hoc edit of a saved sequence/operation).

    A focused write so editing prose never has to round-trip (and risk clobbering) the
    composed cypher/parameters/builder_config. Returns the trimmed value stored.
    """
    qid = (query_id or "").strip()
    if not qid:
        raise ValueError("query id is required")
    description_val = (description or "").strip()
    with catalog_connection() as conn:
        _ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "UPDATE queries SET description = ?, modified_date = datetime('now') WHERE id = ?",
            (description_val, qid),
        )
        if cur.rowcount == 0:
            raise ValueError(f"Unknown query id: {qid!r}")
        conn.commit()
        return {"id": qid, "description": description_val}


def _set_suspended_rows(
    ids: list[str], suspended: bool, kind: str
) -> dict[str, Any]:
    """Flip the ``suspended`` flag on a batch of ``queries`` rows of a given ``kind``.

    Suspension is managed out-of-band from the normal builder upsert (so re-saving never
    silently clears it); this focused write touches only the flag and ``modified_date``.
    Returns the ids whose flag actually changed.
    """
    norm = sorted({(sid or "").strip() for sid in ids if (sid or "").strip()})
    if not norm:
        return {"changed": []}
    value = 1 if suspended else 0
    with catalog_connection() as conn:
        _ensure_queries_policy_columns(conn)
        placeholders = ",".join("?" * len(norm))
        sel = conn.execute(
            f"SELECT id FROM queries WHERE id IN ({placeholders}) "
            f"AND kind = ? AND suspended != ?",
            (*norm, kind, value),
        )
        changed = [(r[0] or "").strip() for r in sel.fetchall() if (r[0] or "").strip()]
        if changed:
            ch_placeholders = ",".join("?" * len(changed))
            conn.execute(
                f"UPDATE queries SET suspended = ?, modified_date = datetime('now') "
                f"WHERE id IN ({ch_placeholders})",
                (value, *changed),
            )
            conn.commit()
        return {"changed": changed}


def set_sequences_suspended(sequence_ids: list[str], suspended: bool) -> dict[str, Any]:
    """Set the ``suspended`` flag on a batch of sequence rows."""
    return _set_suspended_rows(sequence_ids, suspended, "sequence")


def set_operations_suspended(operation_ids: list[str], suspended: bool) -> dict[str, Any]:
    """Set the ``suspended`` flag on a batch of operation rows (standalone INSTANCE ops)."""
    return _set_suspended_rows(operation_ids, suspended, "operation")


def fetch_suspended_query_ids(kind: str) -> set[str]:
    """All ids of a given ``kind`` currently flagged suspended (used to recompute on re-save)."""
    with catalog_connection() as conn:
        _ensure_queries_policy_columns(conn)
        cur = conn.execute(
            "SELECT id FROM queries WHERE kind = ? AND suspended = 1", (kind,)
        )
        return {(row[0] or "").strip() for row in cur.fetchall() if (row[0] or "").strip()}


def fetch_suspended_sequence_ids() -> set[str]:
    """All sequence ids currently flagged suspended (used to recompute on re-save)."""
    return fetch_suspended_query_ids("sequence")


def delete_sequence(sequence_id: str) -> dict[str, Any]:
    """Remove only a sequence's definition (the catalog ``queries`` row, kind = 'sequence')
    plus its composed ``state`` packages — a "remove from the nav" delete that leaves the
    underlying STEP nodes / graph patterns intact.

    Contrast with the STEP delete cascade (``step_delete``), which physically removes the entry
    STEP and every dependent sequence. The ``kind = 'sequence'`` guard prevents this from being
    used to drop a plain operation row.
    """
    sid = (sequence_id or "").strip()
    if not sid:
        raise ValueError("sequence id is required")
    with catalog_connection() as conn:
        cur = conn.execute(
            "DELETE FROM queries WHERE id = ? AND kind = 'sequence'", (sid,)
        )
        queries_deleted = cur.rowcount
        if queries_deleted == 0:
            raise ValueError(f"No sequence with id {sid!r}")
        state_cur = conn.execute(
            "DELETE FROM state WHERE json_extract(package, '$.sequence_query_id') = ?",
            (sid,),
        )
        conn.commit()
        return {
            "id": sid,
            "queries_deleted": queries_deleted,
            "state_deleted": state_cur.rowcount if state_cur.rowcount and state_cur.rowcount > 0 else 0,
        }


def reorder_queries(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Persist nav-bar drag ordering: set each row's sort_order and group_title.

    ``items`` is the ordered list of ``{"id", "group_title", "sort_order"}`` from the
    navigation panel. ``group_title`` may be ``None`` (ungrouped); ``sort_order`` is the
    row's absolute position used by ``fetch_saved_queries``.
    """
    with catalog_connection() as conn:
        if "queries" not in list_user_tables(conn):
            raise ValueError("queries table not found in catalog database")
        _ensure_queries_policy_columns(conn)
        updated = 0
        for index, item in enumerate(items):
            row_id = str(item.get("id") or "").strip()
            if not row_id:
                continue
            raw_group = item.get("group_title")
            group_title = (str(raw_group).strip() or None) if raw_group is not None else None
            raw_order = item.get("sort_order")
            try:
                sort_order = int(raw_order) if raw_order is not None else index
            except (TypeError, ValueError):
                sort_order = index
            cur = conn.execute(
                "UPDATE queries SET sort_order = ?, group_title = ?, "
                "modified_date = datetime('now') WHERE id = ?",
                (sort_order, group_title, row_id),
            )
            updated += cur.rowcount
        conn.commit()
        return {"updated": updated}


_NAV_ROW_TABLES = frozenset({"events", "consoles"})


def rows_space_id(table: str, ids: list[str]) -> str | None:
    """The single space that owns these nav rows, or None when none of the ids exist."""
    if table not in _NAV_ROW_TABLES:
        raise ValueError("unsupported table")
    cleaned = [str(row_id).strip() for row_id in ids if str(row_id).strip()]
    if not cleaned:
        return None
    with catalog_connection() as conn:
        placeholders = ", ".join("?" * len(cleaned))
        rows = conn.execute(
            f"SELECT DISTINCT space_id FROM {table} WHERE id IN ({placeholders})",
            tuple(cleaned),
        ).fetchall()
    found = {str(row[0]) for row in rows if row[0]}
    if len(found) > 1:
        raise ValueError("items must belong to one space")
    return next(iter(found), None)


def reorder_nav_rows(table: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """Persist nav drag ordering for events or consoles (sort_order + group_title)."""
    if table not in _NAV_ROW_TABLES:
        raise ValueError("unsupported table")
    with catalog_connection() as conn:
        updated = 0
        for index, item in enumerate(items):
            row_id = str(item.get("id") or "").strip()
            if not row_id:
                continue
            raw_group = item.get("group_title")
            group_title = (str(raw_group).strip() or None) if raw_group is not None else None
            raw_order = item.get("sort_order")
            try:
                sort_order = int(raw_order) if raw_order is not None else index
            except (TypeError, ValueError):
                sort_order = index
            cur = conn.execute(
                f"UPDATE {table} SET sort_order = ?, group_title = ?, "
                "modified_date = datetime('now') WHERE id = ?",
                (sort_order, group_title, row_id),
            )
            updated += cur.rowcount
        conn.commit()
        return {"updated": updated}
