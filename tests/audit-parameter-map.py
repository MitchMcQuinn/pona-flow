"""
Diagnostic test for the audit log parameter map.

Covers:
  - a catalog that predates ``parameter_map`` gains the column additively;
  - ``record_audit`` stores the map and ``list_audit_log`` returns it;
  - ``update_audit_parameter_map`` replaces the stored map on the same row;
  - a finished sequence run records the resolved map (bindings, caller input,
    return columns, and ``ok``);
  - a run that pauses for input keeps one audit row, and the resume writes the
    completed map back onto that row.

No Neo4j. ``_execute_step`` is stubbed. Catalog is a throwaway SQLite DB.

Run: ``python tests/audit-parameter-map.py`` from the repo root.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config, execution, execution_run, migrations  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def _param(name: str, required: bool = False) -> dict:
    return {"name": name, "value_type": "string", "is_required": required}


def _step(step_id: str, parameters: list[dict] | None = None) -> dict:
    return {
        "id": step_id,
        "query_id": "Q1",
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": parameters or [],
        "next": [],
    }


def _package(steps: list[dict], **extra) -> dict:
    pkg = {
        "steps": steps,
        "response_parameters": [],
        "sequence_query_id": "SEQ_AUDIT",
        "space_id": "SP_TEST",
    }
    if "parameter_values" in extra:
        pkg["parameter_values"] = extra["parameter_values"]
    return pkg


LEGACY_AUDIT_DDL = """
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    space_id TEXT,
    sequence_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sequence_ids)),
    event_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual'
        CHECK (trigger IN ('manual', 'event', 'recovery', 'webhook', 'mcp', 'code', 'external', 'simulated')),
    principal_id TEXT,
    detail TEXT
);
"""

tmpdir = tempfile.mkdtemp(prefix="pona-flow-audit-param-map-")
tmp_db = Path(tmpdir) / "data.db"
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step


def _capture(_space_id, _step, _resolved):
    return {"records": [{"ticket": "T-1"}]}


execution_run._execute_step = _capture  # type: ignore[assignment]

try:
    conn = config.connect_sqlite(tmp_db)
    conn.executescript(LEGACY_AUDIT_DDL)
    conn.execute(
        "INSERT INTO audit_log (id, space_id, sequence_ids, trigger) "
        "VALUES ('a_old', 'SP_TEST', '[]', 'manual')"
    )
    conn.commit()
    before = {r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
    check("legacy table has no parameter_map column", "parameter_map" not in before)

    migrations._ensure_audit_log_parameter_map_column(conn)
    migrations._ensure_audit_log_parameter_map_column(conn)
    after = {r[1] for r in conn.execute("PRAGMA table_info(audit_log)").fetchall()}
    check("migration adds parameter_map", "parameter_map" in after)
    preserved = conn.execute(
        "SELECT trigger FROM audit_log WHERE id = 'a_old'"
    ).fetchone()
    check("migration keeps existing rows", preserved is not None and preserved[0] == "manual")
    conn.close()

    listed = catalog.list_audit_log("SP_TEST")
    old = next((row for row in listed if row["id"] == "a_old"), None)
    check("historical row has a null parameter map", old is not None and old["parameter_map"] is None)

    stored_id = catalog.record_audit(
        "SP_TEST",
        ["SEQ_AUDIT"],
        trigger="manual",
        parameter_map={"city": "Boston"},
    )
    listed = catalog.list_audit_log("SP_TEST")
    stored = next((row for row in listed if row["id"] == stored_id), None)
    check(
        "record_audit stores the parameter map",
        stored is not None and stored["parameter_map"] == {"city": "Boston"},
    )

    catalog.update_audit_parameter_map(stored_id, {"city": "NYC", "ok": True})
    listed = catalog.list_audit_log("SP_TEST")
    updated = next((row for row in listed if row["id"] == stored_id), None)
    check(
        "update_audit_parameter_map replaces the map",
        updated is not None and updated["parameter_map"] == {"city": "NYC", "ok": True},
    )
    check(
        "updating the map does not add a row",
        sum(1 for row in listed if row["id"] == stored_id) == 1,
    )

    # --- finished run writes the resolved map ---------------------------------
    state_id = catalog.insert_state_package(
        _package(
            [_step("lookup", parameters=[_param("city")])],
            parameter_values={"city": "Boston"},
        ),
        status="inactive",
        run_start_date=None,
    )
    result = execution.run_execution(
        "SP_TEST", state_id, params={"note": "hi"}, trigger="manual"
    )
    check("bound run finishes", result.get("status") == "inactive")
    finished = catalog.list_audit_log("SP_TEST")
    run_rows = [row for row in finished if row["sequence_ids"] == ["SEQ_AUDIT"] and row["id"] != stored_id]
    check("finished run writes one audit row", len(run_rows) == 1)
    run_map = (run_rows[0].get("parameter_map") or {}) if run_rows else {}
    check("finished map keeps the sequence binding", run_map.get("city") == "Boston")
    check("finished map keeps the caller value", run_map.get("note") == "hi")
    check("finished map includes the return column", run_map.get("ticket") == "T-1")
    check("finished map includes ok", run_map.get("ok") is True)

    # --- pause then resume updates the same row -------------------------------
    before_count = len(catalog.list_audit_log("SP_TEST"))
    paused_state = catalog.insert_state_package(
        _package([_step("lookup", parameters=[_param("city", required=True)])]),
        status="inactive",
        run_start_date=None,
    )
    pending = execution.run_execution("SP_TEST", paused_state, params={}, trigger="manual")
    check("required input pauses the run", pending.get("status") == "pending")
    progress = (catalog.fetch_state_package(paused_state) or {}).get("progress") or {}
    paused_audit = str(progress.get("audit_id") or "")
    check("paused progress remembers the audit id", bool(paused_audit))
    mid = catalog.list_audit_log("SP_TEST")
    check(
        "pause does not open a second audit row",
        len(mid) == before_count + 1,
    )
    resumed = execution.run_execution(
        "SP_TEST", paused_state, params={"city": "NYC"}, trigger="manual"
    )
    check("resume finishes the run", resumed.get("status") == "inactive")
    after_resume = catalog.list_audit_log("SP_TEST")
    check("resume does not open another audit row", len(after_resume) == len(mid))
    resumed_row = next((row for row in after_resume if row["id"] == paused_audit), None)
    resumed_map = (resumed_row or {}).get("parameter_map") or {}
    check("resumed map has the supplied parameter", resumed_map.get("city") == "NYC")
    check("resumed map includes the step result", resumed_map.get("ticket") == "T-1")
    check("resumed map includes ok", resumed_map.get("ok") is True)

finally:
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All audit parameter-map checks passed.")
