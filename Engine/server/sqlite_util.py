"""
Small shared SQLite schema helpers (introspection + additive column migrations).

The catalog and per-space databases evolve by additive ``ALTER TABLE ADD COLUMN``
migrations guarded by ``PRAGMA table_info`` checks. That ritual used to be re-implemented
per column across catalog / spaces / rbac / migrations; it lives here once.
"""

from __future__ import annotations

import sqlite3


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    )
    return cur.fetchone() is not None


def column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}


def ensure_column(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    ddl: str,
    *,
    commit: bool = True,
) -> bool:
    """
    Additive migration: add *column* to *table* when the table exists and lacks it.

    ``ddl`` is the column definition after the name (e.g. ``TEXT NOT NULL DEFAULT ''``).
    Returns True when the column was added. Set ``commit=False`` when batching several
    adds under one commit.
    """
    if not table_exists(conn, table):
        return False
    if column in column_names(conn, table):
        return False
    conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {ddl}')
    if commit:
        conn.commit()
    return True
