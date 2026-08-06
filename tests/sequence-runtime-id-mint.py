"""
Diagnostic test for run-time minting of create-INSTANCE ids in the executor.

The composer now emits ``id: $id__<alias>`` for create-INSTANCE entities and
declares each as an ``auto_generate`` UID parameter. The executor must:

  - carry ``auto_generate`` through ``_to_step_parameters``;
  - mint a fresh ``ID_…`` per run for each unset auto parameter (never pausing
    for human input, even when the row is marked required);
  - persist the minted value into run progress *before* executing the step, so a
    crash/retry re-runs the step with the same id (MERGE stays idempotent);
  - keep the minted value in ``resolved`` so later steps binding the same
    parameter address the same entity;
  - mint different ids on separate runs (the CREATE_PILLAR fix);
  - exclude auto parameters from a sequence's aggregated (caller-facing)
    parameter schema.

No-op steps (empty query_id + endpoint) are used so the run touches neither
Neo4j nor any HTTP endpoint. The catalog points at a throwaway SQLite DB.

Run: ``python tests/sequence-runtime-id-mint.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# execution_run is patched (not the execution facade) because run_execution
# resolves _execute_step against its defining module's globals.
from Engine.server import catalog, config, execution, execution_run, sequence_service  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- _to_step_parameters carries auto_generate -------------------------------
params = execution._to_step_parameters(
    [
        {"name": "id__pillar", "value_type": "UID", "value": "", "is_required": False,
         "auto_generate": True},
        {"name": "title", "value_type": "string", "value": "", "is_required": True},
    ]
)
by_name = {p["name"]: p for p in params}
check("auto_generate flag survives _to_step_parameters",
      by_name["id__pillar"].get("auto_generate") is True)
check("normal parameters carry no auto_generate flag",
      "auto_generate" not in by_name["title"])


# --- executor: minting, persistence-before-execute, per-run freshness --------
def _step(step_id: str, parameters: list[dict] | None = None,
          transitions: list[dict] | None = None) -> dict:
    return {
        "id": step_id,
        "query_id": "",
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": parameters or [],
        "next": transitions or [],
    }


AUTO_PARAM = {"name": "id__pillar", "value_type": "UID", "is_required": True,
              "auto_generate": True}


def _package() -> dict:
    return {
        "steps": [
            _step("create_pillar", [dict(AUTO_PARAM)], [{"id": "relate", "condition_parameter": ""}]),
            _step("relate", [dict(AUTO_PARAM)]),
        ],
        "response_parameters": [],
        "sequence_query_id": "SEQ_MINT",
        "space_id": "SP_TEST",
    }


tmpdir = tempfile.mkdtemp(prefix="pona-flow-mint-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

try:
    # A required auto parameter must not pause the run; the executor mints it.
    state_id = catalog.insert_state_package(_package(), status="inactive", run_start_date=None)
    result = execution.run_execution("SP_TEST", state_id, params=None)
    check("run completes without pausing for the auto parameter",
          result.get("status") == "inactive")
    minted = str(result.get("resolved", {}).get("id__pillar") or "")
    check("a fresh ID_ value was minted", minted.startswith("ID_") and len(minted) > 3)
    check("both steps executed",
          {e["step_id"] for e in result.get("executed") or []} == {"create_pillar", "relate"})

    # A separate run mints a different id (distinct pillars per run).
    state_id2 = catalog.insert_state_package(_package(), status="inactive", run_start_date=None)
    result2 = execution.run_execution("SP_TEST", state_id2, params=None)
    minted2 = str(result2.get("resolved", {}).get("id__pillar") or "")
    check("a second run mints a different id", minted2.startswith("ID_") and minted2 != minted)

    # Crash-retry: the minted id is persisted before the step executes, so a retry
    # re-runs the same step with the same id instead of minting a duplicate.
    state_id3 = catalog.insert_state_package(_package(), status="inactive", run_start_date=None)
    original_execute = execution_run._execute_step
    calls = {"n": 0}

    def _explode_once(space_id, step, resolved):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated crash mid-step")
        return original_execute(space_id, step, resolved)

    execution_run._execute_step = _explode_once  # type: ignore[assignment]
    try:
        crashed = False
        try:
            execution.run_execution("SP_TEST", state_id3, params=None)
        except RuntimeError:
            crashed = True
        check("simulated crash propagated", crashed)

        row = catalog.fetch_state_package(state_id3)
        progress = (row or {}).get("progress") or {}
        persisted = str((progress.get("resolved") or {}).get("id__pillar") or "")
        check("minted id was persisted before the step executed",
              persisted.startswith("ID_"))
        check("crashed step is still at the head of the persisted queue",
              (progress.get("queue") or [None])[0] == "create_pillar")
        check("crashed step is not marked visited",
              "create_pillar" not in (progress.get("visited") or []))

        retry = execution.run_execution("SP_TEST", state_id3, params=None)
        check("retry completes", retry.get("status") == "inactive")
        check("retry reuses the persisted id (no duplicate mint)",
              retry.get("resolved", {}).get("id__pillar") == persisted)
    finally:
        execution_run._execute_step = original_execute  # type: ignore[assignment]

    # Aggregated (caller-facing) sequence parameters hide auto_generate rows.
    original_compose = execution.compose_execution_package
    execution.compose_execution_package = lambda sid, qid: _package()  # type: ignore[assignment]
    try:
        aggregated = sequence_service._aggregate_parameters("SP_TEST", "SEQ_MINT")
        check("aggregated sequence parameters exclude auto_generate rows",
              all(not p.get("auto_generate") for p in aggregated)
              and all(p.get("name") != "id__pillar" for p in aggregated))
    finally:
        execution.compose_execution_package = original_compose  # type: ignore[assignment]
finally:
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
