"""
Diagnostic test for the catalog ``spaces.dev_mode`` flag.

Covers:
  - ``update_space`` writes ``dev_mode`` when ``set_dev_mode`` is true;
  - omitting ``set_dev_mode`` leaves the stored flag unchanged (a name/endpoint
    save must not silently turn previews off);
  - ``fetch_space_record`` surfaces the flag as a boolean.

Runs against a throwaway SQLite catalog DB (no Neo4j needed).

Run (from repo root, with the project venv so the package imports resolve):
    .venv/bin/python tests/space-dev-mode.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, spaces  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-dev-mode-test-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    conn.execute(
        """
        CREATE TABLE spaces (
            id TEXT PRIMARY KEY,
            name TEXT,
            endpoint TEXT,
            labels TEXT,
            neo4j_uri_key TEXT,
            neo4j_user_key TEXT,
            neo4j_password_key TEXT,
            sqlite_database_path_key TEXT
        )
        """
    )
    conn.execute(
        """
        INSERT INTO spaces (
            id, name, endpoint, labels,
            neo4j_uri_key, neo4j_user_key, neo4j_password_key, sqlite_database_path_key
        ) VALUES (
            'DEMO', 'DEMO', NULL, '{"labels":[]}',
            'DEMO_NEO4J_URI', 'DEMO_NEO4J_USER', 'DEMO_NEO4J_PASSWORD',
            'DEMO_SQLITE_DATABASE_PATH'
        )
        """
    )
    conn.commit()
    conn.close()

    record = spaces.fetch_space_record("DEMO")
    check("unset column reads as off", record["dev_mode"] is False)

    spaces.update_space(
        "DEMO",
        "DEMO",
        description="",
        set_description=True,
        set_dev_mode=True,
        dev_mode=True,
    )
    record = spaces.fetch_space_record("DEMO")
    check("turning the flag on persists through a settings-form save", record["dev_mode"] is True)

    spaces.update_space("DEMO", "DEMO", endpoint="https://example.test")
    record = spaces.fetch_space_record("DEMO")
    check("a save without set_dev_mode keeps the flag on", record["dev_mode"] is True)

    result = spaces.update_space("DEMO", "DEMO", set_dev_mode=True, dev_mode=False)
    check("update result includes the new flag", result.get("dev_mode") is False)
    record = spaces.fetch_space_record("DEMO")
    check("turning the flag off persists", record["dev_mode"] is False)

finally:
    pass

if failures:
    print(f"\n{len(failures)} failure(s): {failures}")
    sys.exit(1)
print("\nAll checks passed.")
