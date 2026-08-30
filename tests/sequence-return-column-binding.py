"""
Diagnostic test for automatic binding of a query step's RETURN columns.

A parameter-gated transition is evaluated against the executor's ``resolved`` map,
so a boolean a read step computed (``r.id IS NOT NULL AS hasExistingConnection``)
only gates a branch once it lands there. ``execution._bind_query_return_columns``
publishes those columns without clobbering the run's inputs.

Covers:
  - the binding rules (query steps only, first record, scalars only, skip nulls,
    never overwrite an already-resolved name, identifier-shaped aliases only);
  - end-to-end ``execution.run_execution`` on the shape that motivated this: a read
    step reporting ``hasExistingConnection`` gates a create step, and the read's
    null OPTIONAL MATCH column does not erase the caller's input of the same name;
  - ``response_parameters`` still overwriting an auto-bound name.

``execution_run._execute_step`` is patched with canned responses so the run touches
neither Neo4j nor any HTTP endpoint. The catalog points at a throwaway SQLite DB.

Run: ``python tests/sequence-return-column-binding.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config, execution, execution_run  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def _query_step(step_id: str, transitions: list[dict] | None = None) -> dict:
    return {
        "id": step_id,
        "query_id": f"query-{step_id}",
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": [],
        "next": transitions or [],
    }


def _bind(step: dict, records: list, resolved: dict) -> dict:
    execution._bind_query_return_columns(step, {"records": records}, resolved)
    return resolved


# --- binding rules ----------------------------------------------------------
step = _query_step("read")

check(
    "scalar columns bind under their alias",
    _bind(step, [{"name": "Ada", "count": 3, "ratio": 1.5}], {})
    == {"name": "Ada", "count": 3, "ratio": 1.5},
)

# The whole point of the feature: a false flag must bind, or the false branch of a
# condition_expected pair can never be distinguished from an unresolved parameter.
check(
    "a false boolean binds rather than being skipped as empty",
    _bind(step, [{"hasExistingConnection": False}], {}) == {"hasExistingConnection": False},
)
check("a zero binds", _bind(step, [{"total": 0}], {}) == {"total": 0})
check("an empty string binds", _bind(step, [{"note": ""}], {}) == {"note": ""})

# An OPTIONAL MATCH that missed returns null for its columns; binding that would
# erase the id a later step needs.
check(
    "a null column is skipped and leaves the caller's value intact",
    _bind(step, [{"entitySchemaId": None}], {"entitySchemaId": "ES1"})
    == {"entitySchemaId": "ES1"},
)
check(
    "a null column does not introduce the name",
    _bind(step, [{"entitySchemaId": None}], {}) == {},
)

# A create step's implicit RETURN * yields node/relationship property maps.
check(
    "node/relationship maps are skipped",
    _bind(step, [{"n156": {"id": "NB1"}, "labels": ["INSTANCE"]}], {}) == {},
)

check(
    "an already-resolved name is never overwritten",
    _bind(step, [{"notebookId": "FROM_QUERY"}], {"notebookId": "FROM_CALLER"})
    == {"notebookId": "FROM_CALLER"},
)

# An unaliased projection is keyed by its raw expression text, which no step could
# reference as $name.
check(
    "a non-identifier column name is skipped",
    _bind(step, [{"r145.id IS NOT NULL": True, "ok": True}], {}) == {"ok": True},
)

check(
    "only the first record is bound",
    _bind(step, [{"id": "first"}, {"id": "second"}], {}) == {"id": "first"},
)
check("no records binds nothing", _bind(step, [], {}) == {})

# Code/endpoint steps return a caller-shaped body whose keys are not parameter names.
check(
    "a non-query step binds nothing",
    _bind(
        {"id": "http", "query_id": "", "endpoint": "http://example.test/x"},
        [{"hasExistingConnection": False}],
        {},
    )
    == {},
)


# --- end-to-end: the conditional-connection shape ---------------------------
CREATE_STEP = "create_connection"
READ_STEP = "read_connection"

# What the read step's Cypher returns. The entitySchemaId column is null on the
# "no connection yet" path because its OPTIONAL MATCH hop missed.
read_response: dict = {}


def _fake_execute_step(space_id, step, resolved):
    if step["id"] == READ_STEP:
        return {"records": [dict(read_response)]}
    executed_resolved[step["id"]] = dict(resolved)
    return {"records": []}


executed_resolved: dict[str, dict] = {}


def _package(response_parameters: list[dict] | None = None) -> dict:
    return {
        "steps": [
            _query_step(
                READ_STEP,
                [
                    {
                        "id": CREATE_STEP,
                        "condition_parameter": "hasExistingConnection",
                        "condition_expected": False,
                    }
                ],
            ),
            _query_step(CREATE_STEP),
        ],
        "response_parameters": response_parameters or [],
        "sequence_query_id": "SEQ_CONDITIONAL_CONNECTION",
        "space_id": "SP_TEST",
    }


def run(package: dict, params: dict) -> dict:
    executed_resolved.clear()
    state_id = catalog.insert_state_package(
        package, status="inactive", run_start_date=None
    )
    return execution.run_execution("SP_TEST", state_id, params=params)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-return-bind-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
_original_execute = execution_run._execute_step
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]
execution_run._execute_step = _fake_execute_step  # type: ignore[assignment]

CALLER_PARAMS = {"notebookId": "NB1", "entitySchemaId": "ES1", "isReadOnly": "false"}

try:
    # No existing connection -> the create step runs.
    read_response = {
        "hasExistingConnection": False,
        "notebookId": "NB1",
        "entitySchemaId": None,
    }
    result = run(_package(), CALLER_PARAMS)
    visited = {e["step_id"] for e in result.get("executed") or []}
    check("no existing connection reaches the create step", visited == {READ_STEP, CREATE_STEP})
    check(
        "the read's flag is resolved as a real boolean",
        result["resolved"].get("hasExistingConnection") is False,
    )
    check(
        "the create step still sees the caller's entitySchemaId",
        executed_resolved.get(CREATE_STEP, {}).get("entitySchemaId") == "ES1",
    )
    check(
        "the create step still sees the caller's isReadOnly",
        executed_resolved.get(CREATE_STEP, {}).get("isReadOnly") == "false",
    )

    # Existing connection -> the create step is skipped.
    read_response = {
        "hasExistingConnection": True,
        "notebookId": "NB1",
        "entitySchemaId": "ES1",
    }
    result = run(_package(), CALLER_PARAMS)
    visited = {e["step_id"] for e in result.get("executed") or []}
    check("an existing connection skips the create step", visited == {READ_STEP})

    # An explicit mapping runs after the auto-bind and still wins.
    read_response = {"hasExistingConnection": False, "flagCopy": True}
    result = run(
        _package(
            [{"property_path": "records[0].flagCopy", "parameter": "hasExistingConnection"}]
        ),
        CALLER_PARAMS,
    )
    visited = {e["step_id"] for e in result.get("executed") or []}
    check(
        "an explicit response_parameter overrides the auto-bound column",
        result["resolved"].get("hasExistingConnection") is True and visited == {READ_STEP},
    )
finally:
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]
    execution_run._execute_step = _original_execute  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
