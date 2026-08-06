"""
Diagnostic test for the delete_space cascade in Engine/server/spaces.py.

Covers:
  - deleting a space removes its space_members, space_roles, events, and agent_keys
    rows plus the synthetic agent users created for those keys;
  - another space's rows (and human users) are untouched;
  - audit_log rows are deliberately retained as run history;
  - deleting an unknown space still raises ValueError.

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so FastAPI is importable):
    .venv/bin/python tests/space-delete-cascade.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import agent_keys, catalog, config, rbac, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-delete-cascade-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    for ddl in ("users-table.sql", "events-table.sql", "agent-keys-table.sql", "audit-log-table.sql"):
        conn.executescript(
            (config.ROOT / "Engine" / "schema" / ddl).read_text(encoding="utf-8")
        )
    conn.execute("CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('demo', 'demo')")
    conn.execute("INSERT INTO spaces (id, name) VALUES ('keep', 'keep')")
    conn.commit()
    rbac.ensure_rbac_schema(conn)
    conn.execute(
        "INSERT INTO users (id, clerk_user_id, email) VALUES "
        "('u_human', 'clerk_u_human', 'human@example.com')"
    )
    conn.execute(
        "INSERT INTO events (id, space_id, name, type) VALUES ('ev_demo', 'demo', 'nightly', 'time')"
    )
    conn.execute(
        "INSERT INTO events (id, space_id, name, type) VALUES ('ev_keep', 'keep', 'weekly', 'time')"
    )
    conn.commit()
    conn.close()

    rbac.add_member("demo", "u_human", is_owner=True)
    rbac.add_member("keep", "u_human", is_owner=True)
    demo_key = agent_keys.mint_key("demo", "demo-agent")
    keep_key = agent_keys.mint_key("keep", "keep-agent")
    audit_id = catalog.record_audit("demo", ["ID_seq1"], trigger="manual", principal_id="u_human")

    def count(table: str, where: str, *args: str) -> int:
        c = config.connect_sqlite(tmp_db)
        try:
            return c.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", args).fetchone()[0]
        finally:
            c.close()

    check("demo has members before delete", count("space_members", "space_id = ?", "demo") > 0)
    check("demo has roles before delete", count("space_roles", "space_id = ?", "demo") > 0)
    check("demo has an agent key before delete", count("agent_keys", "space_id = ?", "demo") == 1)

    result = spaces.delete_space("demo")
    check("delete_space reports deleted", bool(result.get("deleted")))

    check("spaces row removed", count("spaces", "id = ?", "demo") == 0)
    check("space_members cascade", count("space_members", "space_id = ?", "demo") == 0)
    check("space_roles cascade", count("space_roles", "space_id = ?", "demo") == 0)
    check("events cascade", count("events", "space_id = ?", "demo") == 0)
    check("agent_keys cascade", count("agent_keys", "space_id = ?", "demo") == 0)
    check(
        "demo's synthetic agent user removed",
        count("users", "id = ?", demo_key["principal_id"]) == 0,
    )
    check(
        "revoked key no longer verifies",
        agent_keys.verify_key(demo_key["token"]) is None,
    )

    # Other space + humans untouched; audit history retained.
    check("keep space row intact", count("spaces", "id = ?", "keep") == 1)
    check("keep members intact", count("space_members", "space_id = ?", "keep") > 0)
    check("keep roles intact", count("space_roles", "space_id = ?", "keep") > 0)
    check("keep events intact", count("events", "space_id = ?", "keep") == 1)
    check("keep agent key intact", count("agent_keys", "space_id = ?", "keep") == 1)
    check(
        "keep's agent user intact",
        count("users", "id = ?", keep_key["principal_id"]) == 1,
    )
    check("human user intact", count("users", "id = ?", "u_human") == 1)
    check("audit_log history retained", count("audit_log", "id = ?", audit_id) == 1)

    try:
        spaces.delete_space("demo")
        check("deleting an unknown space raises", False)
    except ValueError:
        check("deleting an unknown space raises", True)

finally:
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All delete-cascade checks passed.")
