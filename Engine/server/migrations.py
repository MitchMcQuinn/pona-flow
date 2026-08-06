"""
Catalog database migrations — deterministic, ordered startup schema application.

Purpose in the project
----------------------
Historically the dev server applied schema lazily and ad hoc (each module created its
own tables on first access). That is fragile across the many hosted single-tenant
instances we now operate. This module gives a single, ordered, idempotent place that
brings a catalog ``data.db`` up to the current schema at startup.

It applies the catalog DDL files under ``Engine/schema/`` in a fixed order and ensures
the ``spaces`` table's added columns exist. All DDL uses ``IF NOT EXISTS`` (or additive
``ALTER``), so running this repeatedly is safe.

Per-space ``entities`` tables are intentionally *not* handled here: they live in
per-space SQLite files and are migrated on space access by ``server.spaces``.
"""

from __future__ import annotations

import sqlite3

from . import catalog, config, rbac, spaces, sqlite_util

_SCHEMA_DIR = config.ROOT / "Engine" / "schema"

# Applied in order. Each file is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
# NOTE: ``space-members`` is intentionally absent — its table can require a rebuild
# from the legacy (space_id, user_id) shape, so it is owned by ``rbac.ensure_rbac_schema``.
_CATALOG_DDL_FILES = (
    "regex-table.sql",
    "state-table.sql",
    "queries-table.sql",
    "users-table.sql",
    "space-roles-table.sql",
    "events-table.sql",
    "audit-log-table.sql",
    "agent-keys-table.sql",
    "space-credentials-table.sql",
    "resources-table.sql",
    "template-imports-table.sql",
)


def _apply_sql_file(conn: sqlite3.Connection, filename: str) -> None:
    path = _SCHEMA_DIR / filename
    if not path.is_file():
        return
    conn.executescript(path.read_text(encoding="utf-8"))


def _ensure_audit_log_detail_column(conn: sqlite3.Connection) -> None:
    """Additive migration: optional JSON ``detail`` column (code-execution outcomes)."""
    sqlite_util.ensure_column(conn, "audit_log", "detail", "TEXT")


def _ensure_events_external_column(conn: sqlite3.Connection) -> None:
    """Additive migration: ``external_package`` column on the events table.

    Holds the inbound-trigger config (ingest token, optional secret, match filters,
    payload->param mappings). Older catalogs predate it; the ALTER is additive and
    safe to run repeatedly."""
    sqlite_util.ensure_column(
        conn, "events", "external_package", "TEXT NOT NULL DEFAULT '{}'"
    )


def _ensure_audit_log_trigger_check(conn: sqlite3.Connection) -> None:
    """Rebuild ``audit_log`` if its trigger CHECK predates 'webhook'/'mcp'/'code'/'external'.

    SQLite cannot alter a CHECK constraint in place, so (like the legacy
    ``space_members`` rebuild in ``rbac``) we rename, recreate from the current DDL
    file, copy the rows, and drop the old table.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'"
    ).fetchone()
    if row is None or "'external'" in (row[0] or ""):
        return
    old_cols = [r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()]
    conn.execute("ALTER TABLE audit_log RENAME TO audit_log_legacy")
    # Indexes follow the renamed table; drop them so the DDL file can recreate them.
    conn.execute("DROP INDEX IF EXISTS idx_audit_log_run_at")
    conn.execute("DROP INDEX IF EXISTS idx_audit_log_space")
    _apply_sql_file(conn, "audit-log-table.sql")
    new_cols = {r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
    copy_cols = ", ".join(c for c in old_cols if c in new_cols)
    conn.execute(
        f"INSERT INTO audit_log ({copy_cols}) SELECT {copy_cols} FROM audit_log_legacy"
    )
    conn.execute("DROP TABLE audit_log_legacy")
    conn.commit()


def run_startup_migrations() -> None:
    """Bring the catalog database to the current schema. Safe to call repeatedly."""
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        for filename in _CATALOG_DDL_FILES:
            _apply_sql_file(conn, filename)
        conn.commit()
        # Add the events.external_package column on catalogs that predate external triggers.
        _ensure_events_external_column(conn)
        # Rebuild audit_log when its trigger CHECK is missing 'webhook'/'mcp'/'code'/'external',
        # then add the detail column on databases that predate it.
        _ensure_audit_log_trigger_check(conn)
        _ensure_audit_log_detail_column(conn)
        # Additive column migrations on the existing spaces table (groups/is_private/dev_mode).
        spaces.ensure_catalog_space_schema(conn)
        # Queries policy/metadata columns (kind/operation/suspended/...) for legacy catalogs.
        catalog.ensure_queries_policy_columns(conn)
        # RBAC: add user columns, rebuild legacy space_members, seed default roles.
        rbac.ensure_rbac_schema(conn)
    finally:
        conn.close()
