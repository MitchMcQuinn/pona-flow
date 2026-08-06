"""
Diagnostic test for the audit_log trigger taxonomy (webhook/mcp) and its migration.

Covers:
  - a legacy audit_log table (old three-value CHECK, no principal_id) is rebuilt by
    migrations._ensure_audit_log_trigger_check, preserving existing rows and indexes;
  - the rebuild is idempotent (running it again is a no-op);
  - catalog.record_audit persists 'webhook' and 'mcp' triggers verbatim;
  - unknown trigger values are still coerced to 'manual'.

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/audit-trigger-values.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config, migrations  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# The audit_log shape as shipped before webhook/mcp (and before principal_id).
LEGACY_AUDIT_DDL = """
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    space_id TEXT,
    sequence_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sequence_ids)),
    event_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'event', 'recovery'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_run_at ON audit_log (run_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_space ON audit_log (space_id);
"""

tmpdir = tempfile.mkdtemp(prefix="pona-flow-audit-trigger-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    conn.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
    conn.executescript(LEGACY_AUDIT_DDL)
    conn.execute(
        "INSERT INTO audit_log (id, space_id, sequence_ids, trigger) "
        "VALUES ('a_legacy', 'demo', '[\"ID_old\"]', 'event')"
    )
    conn.commit()

    import sqlite3

    legacy_rejects = False
    try:
        conn.execute(
            "INSERT INTO audit_log (id, sequence_ids, trigger) VALUES ('a_wh', '[]', 'webhook')"
        )
    except sqlite3.IntegrityError:
        legacy_rejects = True
    check("legacy CHECK rejects 'webhook'", legacy_rejects)

    # --- rebuild migration ------------------------------------------------------
    migrations._ensure_audit_log_trigger_check(conn)
    sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'"
    ).fetchone()[0]
    check(
        "rebuilt CHECK includes webhook, mcp, and external",
        "'webhook'" in sql and "'mcp'" in sql and "'external'" in sql,
    )

    row = conn.execute(
        "SELECT space_id, sequence_ids, trigger FROM audit_log WHERE id = 'a_legacy'"
    ).fetchone()
    check(
        "legacy row preserved across rebuild",
        row is not None and row[0] == "demo" and row[2] == "event",
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
    check("rebuilt table has principal_id column", "principal_id" in cols)
    check(
        "legacy table dropped",
        conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'audit_log_legacy'"
        ).fetchone()[0]
        == 0,
    )
    index_names = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'"
        ).fetchall()
    }
    check(
        "indexes recreated on the rebuilt table",
        {"idx_audit_log_run_at", "idx_audit_log_space"} <= index_names,
    )

    # Idempotent: running again must not error or lose rows.
    migrations._ensure_audit_log_trigger_check(conn)
    check(
        "rebuild is idempotent",
        conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 1,
    )
    conn.close()

    # --- record_audit taxonomy --------------------------------------------------
    def trigger_of(audit_id: str) -> str:
        c = config.connect_sqlite(tmp_db)
        try:
            return c.execute(
                "SELECT trigger FROM audit_log WHERE id = ?", (audit_id,)
            ).fetchone()[0]
        finally:
            c.close()

    wh = catalog.record_audit("demo", ["ID_seq"], trigger="webhook", principal_id="u_agent")
    check("webhook trigger persists verbatim", trigger_of(wh) == "webhook")

    mcp = catalog.record_audit("demo", ["ID_seq"], trigger="mcp", principal_id="u_agent")
    check("mcp trigger persists verbatim", trigger_of(mcp) == "mcp")

    ext = catalog.record_audit("demo", ["ID_seq"], trigger="external", principal_id="u_agent")
    check("external trigger persists verbatim", trigger_of(ext) == "external")

    ev = catalog.record_audit("demo", ["ID_seq"], trigger="event")
    check("event trigger still persists", trigger_of(ev) == "event")

    unknown = catalog.record_audit("demo", ["ID_seq"], trigger="cosmic-rays")
    check("unknown trigger coerced to manual", trigger_of(unknown) == "manual")

finally:
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All audit-trigger checks passed.")
