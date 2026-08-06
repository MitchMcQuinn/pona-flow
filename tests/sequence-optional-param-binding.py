"""
Diagnostic test for empty-optional-parameter binding in the executor.

The UI submits blank inputs as "" and run_execution's resolve loop skips
empties, so an optional parameter with no default never reached ``resolved``.
A query step's stored Cypher still references it (e.g. ``DO_DATE: $actionDoDate``
in CREATE_ACTION's MERGE), and Neo4j rejects a statement with an unbound
parameter — so leaving an optional date blank failed the whole run.

The executor must now, for query steps only:

  - bind blank optional parameters to "" (not null: MERGE refuses null
    property values) so every ``$name`` in the Cypher is bound;
  - let caller-supplied values and author defaults win over the "" fill;
  - leave required parameters alone (blank required still pauses the run);
  - leave response-bound parameters alone (upstream steps populate those);
  - not fill parameters on code/endpoint steps, which deliberately leave
    unknown ``$name`` tokens untouched.

``_execute_step`` is monkeypatched to capture the resolved dict per step, so
the run touches neither Neo4j nor any HTTP endpoint. The catalog points at a
throwaway SQLite DB.

Run: ``python tests/sequence-optional-param-binding.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# execution_run is patched (not the execution facade) because run_execution
# resolves _execute_step against its defining module's globals.
from Engine.server import catalog, config, execution, execution_run  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def _param(name: str, required: bool = False, **extra) -> dict:
    return {"name": name, "value_type": "string", "is_required": required, **extra}


def _package(steps: list[dict], response_parameters: list[dict] | None = None) -> dict:
    return {
        "steps": steps,
        "response_parameters": response_parameters or [],
        "sequence_query_id": "SEQ_OPT_BIND",
        "space_id": "SP_TEST",
    }


def _step(step_id: str, query_id: str, endpoint: str = "",
          parameters: list[dict] | None = None,
          transitions: list[dict] | None = None) -> dict:
    return {
        "id": step_id,
        "query_id": query_id,
        "endpoint": endpoint,
        "headers": {},
        "body": {},
        "parameters": parameters or [],
        "next": transitions or [],
    }


tmpdir = tempfile.mkdtemp(prefix="pona-flow-opt-bind-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step
snapshots: dict[str, dict] = {}


def _capture(space_id, step, resolved):
    # ``resolved`` is shared and mutated across steps; snapshot it per step.
    snapshots[str(step.get("id"))] = dict(resolved)
    return {"records": []}


execution_run._execute_step = _capture  # type: ignore[assignment]

try:
    # --- CREATE_ACTION shape: blank optional dates on a query step -----------
    package = _package(
        steps=[
            _step(
                "create_action",
                query_id="query-mrwun5j9-97",
                parameters=[
                    _param("actionName", required=True),
                    _param("actionDoDate"),
                    _param("actionDueDate"),
                    _param("actionIsComplete", default_value="false"),
                    _param("createdId"),
                ],
                transitions=[{"id": "notify", "condition_parameter": ""}],
            ),
            _step(
                "notify",
                query_id="",
                endpoint="https://example.invalid/hook",
                parameters=[_param("notifyMessage")],
            ),
        ],
        response_parameters=[{"parameter": "createdId", "property_path": "id"}],
    )
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    result = execution.run_execution(
        "SP_TEST", state_id,
        params={"actionName": "Test action", "actionDoDate": "", "actionDueDate": ""},
    )
    check("run with blank optional dates completes", result.get("status") == "inactive")

    query_resolved = snapshots.get("create_action") or {}
    check("blank optional actionDoDate is bound as empty string",
          query_resolved.get("actionDoDate") == "")
    check("blank optional actionDueDate is bound as empty string",
          query_resolved.get("actionDueDate") == "")
    check("caller-supplied required value is untouched",
          query_resolved.get("actionName") == "Test action")
    check("author default wins over the empty-string fill",
          query_resolved.get("actionIsComplete") == "false")
    check("response-bound parameter is not filled with empty string",
          "createdId" not in query_resolved)

    endpoint_resolved = snapshots.get("notify") or {}
    check("endpoint step's blank optional parameter is not filled",
          "notifyMessage" not in endpoint_resolved)

    # --- caller value wins over the fill --------------------------------------
    snapshots.clear()
    state_id2 = catalog.insert_state_package(
        _package([_step("create_action", query_id="Q1",
                        parameters=[_param("actionDoDate")])]),
        status="inactive", run_start_date=None,
    )
    execution.run_execution("SP_TEST", state_id2, params={"actionDoDate": "2026-08-01"})
    check("caller-supplied optional value wins over the empty-string fill",
          (snapshots.get("create_action") or {}).get("actionDoDate") == "2026-08-01")

    # --- blank required parameter still pauses the run -------------------------
    snapshots.clear()
    state_id3 = catalog.insert_state_package(
        _package([_step("create_action", query_id="Q1",
                        parameters=[_param("actionName", required=True)])]),
        status="inactive", run_start_date=None,
    )
    result3 = execution.run_execution("SP_TEST", state_id3, params={"actionName": ""})
    check("blank required parameter still pauses for human input",
          result3.get("status") == "pending")
    check("required parameter was not silently filled with empty string",
          "actionName" not in (result3.get("resolved") or {}))
finally:
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
