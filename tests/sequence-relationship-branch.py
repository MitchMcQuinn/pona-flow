"""
Diagnostic test for relationship-condition branching in the execution engine.

Covers the "expected result" boolean added to parameter-gated transitions, which
lets two sibling relationships branch on a single parameter (one edge active when
the parameter is true, the other when it is false):

  - ``execution._coerce_bool`` strict coercion ("true"/"1" -> True; "false"/"0"/
    anything else/unresolved -> False).
  - ``execution._build_step`` carries ``condition_expected`` onto transitions.
  - End-to-end ``execution.run_execution`` follows only the branch whose expected
    result matches the parameter, and still honours legacy truthy gating when no
    expected result is configured.

No-op steps (empty query_id + endpoint) are used so the run touches neither Neo4j
nor any HTTP endpoint. The catalog points at a throwaway SQLite DB.

Run: ``python tests/sequence-relationship-branch.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, config, execution  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- _coerce_bool: strict boolean coercion ----------------------------------
# Numeric 1 / 1.0 count as true (numerically one); the string "1.0" does not,
# since only the literal "1"/"true" strings are accepted.
TRUE_INPUTS = ["true", "True", "TRUE", " true ", "1", 1, 1.0, True]
FALSE_INPUTS = ["false", "False", "0", 0, "no", "yes", "", "null", None, "2", "1.0", 2.5]

for value in TRUE_INPUTS:
    check(f"_coerce_bool({value!r}) is True", execution._coerce_bool(value) is True)
for value in FALSE_INPUTS:
    check(f"_coerce_bool({value!r}) is False", execution._coerce_bool(value) is False)


# --- _build_step: transitions carry condition_expected ----------------------
adjacency = {
    "start": [
        {"target": "yes_step", "condition_type": "parameter", "condition": "$flag",
         "condition_expected": True},
        {"target": "no_step", "condition_type": "parameter", "condition": "flag",
         "condition_expected": False},
        {"target": "legacy_step", "condition_type": "parameter", "condition": "flag"},
        {"target": "always_step", "condition_type": "", "condition": ""},
    ]
}
built = execution._build_step("start", {"payload": {}}, adjacency)
by_target = {t["id"]: t for t in built["next"]}

check("true-branch keeps its parameter", by_target["yes_step"]["condition_parameter"] == "flag")
check("true-branch expects True", by_target["yes_step"].get("condition_expected") is True)
check("false-branch expects False", by_target["no_step"].get("condition_expected") is False)
check(
    "legacy parameter edge omits condition_expected",
    "condition_expected" not in by_target["legacy_step"],
)
check(
    "unconditional edge has empty parameter",
    by_target["always_step"]["condition_parameter"] == "",
)
check(
    "unconditional edge omits condition_expected",
    "condition_expected" not in by_target["always_step"],
)


# --- run_execution: end-to-end branch selection -----------------------------
def _noop_step(step_id: str, transitions: list[dict] | None = None) -> dict:
    return {
        "id": step_id,
        "query_id": "",
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": [],
        "next": transitions or [],
    }


def _branch_package() -> dict:
    return {
        "steps": [
            _noop_step(
                "start",
                [
                    {"id": "true_branch", "condition_parameter": "flag",
                     "condition_expected": True},
                    {"id": "false_branch", "condition_parameter": "flag",
                     "condition_expected": False},
                ],
            ),
            _noop_step("true_branch"),
            _noop_step("false_branch"),
        ],
        "response_parameters": [],
        "sequence_query_id": "SEQ_BRANCH",
        "space_id": "SP_TEST",
    }


def _legacy_package() -> dict:
    """Single parameter-gated edge with no expected result -> legacy truthy gating."""
    return {
        "steps": [
            _noop_step(
                "start",
                [{"id": "next_step", "condition_parameter": "flag"}],
            ),
            _noop_step("next_step"),
        ],
        "response_parameters": [],
        "sequence_query_id": "SEQ_LEGACY",
        "space_id": "SP_TEST",
    }


def run_branch(flag_value) -> set[str]:
    params = {"flag": flag_value} if flag_value is not None else None
    state_id = catalog.insert_state_package(
        _branch_package(), status="inactive", run_start_date=None
    )
    result = execution.run_execution("SP_TEST", state_id, params=params)
    return {e["step_id"] for e in result.get("executed") or []}


def run_legacy(flag_value) -> set[str]:
    params = {"flag": flag_value} if flag_value is not None else None
    state_id = catalog.insert_state_package(
        _legacy_package(), status="inactive", run_start_date=None
    )
    result = execution.run_execution("SP_TEST", state_id, params=params)
    return {e["step_id"] for e in result.get("executed") or []}


tmpdir = tempfile.mkdtemp(prefix="pona-flow-branch-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    for raw, label in [("true", "true"), ("TRUE", "TRUE"), ("1", "1")]:
        visited = run_branch(raw)
        check(f"flag={label!r} follows only the true branch",
              visited == {"start", "true_branch"})

    for raw, label in [("false", "false"), ("0", "0"), ("yes", "yes")]:
        visited = run_branch(raw)
        check(f"flag={label!r} follows only the false branch",
              visited == {"start", "false_branch"})

    # An unresolved parameter coerces to False -> false branch only.
    visited = run_branch(None)
    check("unresolved flag follows only the false branch",
          visited == {"start", "false_branch"})

    # Legacy gating (no expected result) keeps truthy semantics: "yes" is truthy.
    check("legacy: 'true' follows the edge", run_legacy("true") == {"start", "next_step"})
    check("legacy: 'yes' (truthy) follows the edge", run_legacy("yes") == {"start", "next_step"})
    check("legacy: 'false' does not follow", run_legacy("false") == {"start"})
    check("legacy: unresolved does not follow", run_legacy(None) == {"start"})
finally:
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
