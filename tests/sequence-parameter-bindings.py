"""
Diagnostic test for sequence-level STEP parameter bindings.

A sequence can bake values into the STEP parameters it reuses. Those values seed
run state before caller params, skip HITL (including interactive/manual runs),
and drop out of aggregated caller-facing schemas. Empty/omitted bindings still
pause when the STEP param is required.

``_execute_step`` is monkeypatched so the run touches neither Neo4j nor HTTP.

Run: ``python tests/sequence-parameter-bindings.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config, execution, execution_compose, execution_run  # noqa: E402
from Engine.server import sequence_service  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def _param(name: str, required: bool = False, **extra) -> dict:
    return {"name": name, "value_type": "string", "is_required": required, **extra}


def _package(steps: list[dict], **extra) -> dict:
    pkg = {
        "steps": steps,
        "response_parameters": extra.get("response_parameters") or [],
        "sequence_query_id": "SEQ_BIND",
        "space_id": "SP_TEST",
    }
    if "parameter_values" in extra:
        pkg["parameter_values"] = extra["parameter_values"]
    return pkg


def _step(
    step_id: str,
    query_id: str = "Q1",
    parameters: list[dict] | None = None,
    transitions: list[dict] | None = None,
) -> dict:
    return {
        "id": step_id,
        "query_id": query_id,
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": parameters or [],
        "next": transitions or [],
    }


tmpdir = tempfile.mkdtemp(prefix="pona-flow-seq-bind-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step
snapshots: dict[str, dict] = {}


def _capture(space_id, step, resolved):
    snapshots[str(step.get("id"))] = dict(resolved)
    return {"records": []}


execution_run._execute_step = _capture  # type: ignore[assignment]

try:
    # --- Helper: auto_generate and response names are not bindable ------------
    values = execution_compose.sequence_parameter_values(
        [
            {"name": "city", "value": "Boston"},
            {"name": "id__pillar", "value": "should-not-bind"},
            {"name": "createdId", "value": "blocked-output"},
            {"name": "unknown", "value": "no-such-step-param"},
            {"name": "empty", "value": ""},
        ],
        {
            "s1": {
                "parameters": [
                    _param("city", required=True),
                    _param("id__pillar", auto_generate=True),
                    _param("createdId"),
                    _param("empty", required=True),
                ]
            }
        },
        [{"parameter": "createdId", "property_path": "$.id"}],
    )
    check("sequence binding keeps a STEP input", values.get("city") == "Boston")
    check("auto_generate names are not bindable", "id__pillar" not in values)
    check("response_parameters names are not bindable", "createdId" not in values)
    check("unknown names are dropped", "unknown" not in values)
    check("empty values are dropped", "empty" not in values)

    # --- Binding present: interactive run does not pause ----------------------
    snapshots.clear()
    state_id = catalog.insert_state_package(
        _package(
            [_step("lookup", parameters=[_param("city", required=True)])],
            parameter_values={"city": "Boston"},
        ),
        status="inactive",
        run_start_date=None,
    )
    result = execution.run_execution("SP_TEST", state_id, params={})
    check("bound required param skips pending", result.get("status") == "inactive")
    check(
        "binding is in resolved",
        result.get("resolved", {}).get("city") == "Boston",
    )

    # --- Caller value wins over binding ----------------------------------------
    snapshots.clear()
    state_id2 = catalog.insert_state_package(
        _package(
            [_step("lookup", parameters=[_param("city", required=True)])],
            parameter_values={"city": "Boston"},
        ),
        status="inactive",
        run_start_date=None,
    )
    execution.run_execution("SP_TEST", state_id2, params={"city": "NYC"})
    check(
        "caller value wins over sequence binding",
        (snapshots.get("lookup") or {}).get("city") == "NYC",
    )

    # --- Empty/omitted binding still HITLs when required (interactive) --------
    snapshots.clear()
    state_id3 = catalog.insert_state_package(
        _package([_step("lookup", parameters=[_param("city", required=True)])]),
        status="inactive",
        run_start_date=None,
    )
    result3 = execution.run_execution("SP_TEST", state_id3, params={})
    check("unbound required param still pauses", result3.get("status") == "pending")
    check(
        "pending lists the unbound required field",
        any(p.get("name") == "city" for p in (result3.get("parameters") or [])),
    )

    # --- Sibling field: bound name hidden from pending form --------------------
    snapshots.clear()
    state_id4 = catalog.insert_state_package(
        _package(
            [
                _step(
                    "lookup",
                    parameters=[
                        _param("city", required=True),
                        _param("country", required=True),
                    ],
                )
            ],
            parameter_values={"city": "Boston"},
        ),
        status="inactive",
        run_start_date=None,
    )
    result4 = execution.run_execution("SP_TEST", state_id4, params={})
    pending_names = [p.get("name") for p in (result4.get("parameters") or [])]
    check("sibling unbound required still pauses", result4.get("status") == "pending")
    check("bound sibling is hidden from pending form", "city" not in pending_names)
    check("unbound sibling is shown on pending form", "country" in pending_names)

    # --- Aggregated caller schema omits bound names ----------------------------
    original_compose = execution.compose_execution_package
    execution.compose_execution_package = lambda sid, qid: _package(  # type: ignore[assignment]
        [
            _step(
                "lookup",
                parameters=[
                    _param("city", required=True),
                    _param("country", required=True),
                    _param("id__x", auto_generate=True),
                ],
            )
        ],
        parameter_values={"city": "Boston"},
        response_parameters=[],
    )
    try:
        aggregated = sequence_service._aggregate_parameters("SP_TEST", "SEQ_BIND")
        names = [p.get("name") for p in aggregated]
        check("aggregated schema omits bound name", "city" not in names)
        check("aggregated schema keeps unbound name", "country" in names)
        check("aggregated schema omits auto_generate", "id__x" not in names)
    finally:
        execution.compose_execution_package = original_compose  # type: ignore[assignment]

    caller = execution.caller_facing_parameters(
        _package(
            [
                _step(
                    "lookup",
                    parameters=[_param("city", required=True), _param("country")],
                )
            ],
            parameter_values={"city": "Boston"},
        )
    )
    check(
        "caller_facing_parameters omits bound names",
        [p.get("name") for p in caller] == ["country"],
    )
finally:
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
