"""
Diagnostic test for the code-step executor (execution._execute_code_step).

Covers (runner and resources are monkeypatched — no Docker, no network, no Neo4j):
- JSON response wrapping: dict results merge into the response; list and scalar
  results are wrapped ({"records": ...} / {"result": ...}) so response_parameters
  paths and _bind_response_parameters keep working;
- _ok/_status meta keys for the visualizer and the error envelope on failures;
- the kill switch (PONA_FLOW_CODE_EXEC_ENABLED=0) blocks execution;
- output shape validation rejects over-deep runner results;
- $secret.<NAME> is resolved into the code sent to the runner but never persisted;
- one audit record per execution with outcome detail (never code/params/secrets).

Run: ``.venv/bin/python tests/code-exec-step.py`` from the repo root.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# execution_run is patched (not the execution facade) because _execute_code_step
# resolves _call_runner against its defining module's globals.
from Engine.server import execution, execution_run  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


STEP = {"id": "ID_step1", "kind": "code", "resource_id": "ID_res1"}

audits: list[dict] = []
runner_requests: list[dict] = []


def main() -> None:
    saved_load = execution.resources.load_for_execution
    saved_call = execution_run._call_runner
    saved_record = execution.catalog.record_audit
    saved_resolve = execution.credentials.resolve
    saved_env = os.environ.get("PONA_FLOW_CODE_EXEC_ENABLED")

    resource = {
        "id": "ID_res1",
        "name": "demo",
        "language": "python",
        "code": "total = $amount\nkey = '$secret.API_KEY'\nresult = {'total': total}",
    }
    runner_reply: dict = {"ok": True, "outcome": "ok", "result": {"total": 42}}

    def fake_load(space_id, resource_id):
        if resource_id != "ID_res1":
            raise KeyError(f"resource {resource_id!r} not found")
        return dict(resource)

    def fake_call(payload, timeout_seconds):
        runner_requests.append(payload)
        return dict(runner_reply)

    def fake_record(space_id, sequence_ids, event_id=None, trigger="manual",
                    principal_id=None, detail=None):
        audits.append({"space_id": space_id, "trigger": trigger, "detail": detail})
        return "ID_audit"

    execution.resources.load_for_execution = fake_load
    execution_run._call_runner = fake_call
    execution.catalog.record_audit = fake_record
    execution.credentials.resolve = lambda space, name: "s3cr3t" if name == "API_KEY" else None

    try:
        os.environ.pop("PONA_FLOW_CODE_EXEC_ENABLED", None)
        resolved = {"amount": 42}

        # --- dict result merges into the response -----------------------------------
        out = execution._execute_code_step("SPACE", STEP, resolved)
        check("dict result merges into response", out.get("total") == 42)
        check("_ok meta set on success", out.get("_ok") is True)
        check("_status meta present for visualizer", out.get("_status") == 200)
        check("_raw_text carries the JSON result", '"total": 42' in str(out.get("_raw_text")))

        sent_code = runner_requests[-1]["code"]
        check("params substituted into shipped code", "total = 42" in sent_code)
        check("secret resolved into shipped code", "key = 's3cr3t'" in sent_code)
        check("secret never lands in resolved map", "s3cr3t" not in str(resolved))
        check("runner gets language", runner_requests[-1]["language"] == "python")
        check("one audit row per execution", len(audits) == 1)
        check("audit trigger is code", audits[-1]["trigger"] == "code")
        detail = audits[-1]["detail"] or {}
        check(
            "audit detail has resource/outcome/duration",
            detail.get("resource_id") == "ID_res1"
            and detail.get("outcome") == "ok"
            and "duration_ms" in detail,
        )
        check(
            "audit detail never contains code or secrets",
            "s3cr3t" not in str(detail) and "total =" not in str(detail),
        )

        # --- list result wraps as records --------------------------------------------
        runner_reply = {"ok": True, "outcome": "ok", "result": [1, 2, 3]}
        out = execution._execute_code_step("SPACE", STEP, dict(resolved))
        check("list result wrapped as records", out.get("records") == [1, 2, 3])

        # --- scalar / non-JSON-object result wraps as {"result": ...} ---------------
        runner_reply = {"ok": True, "outcome": "ok", "result": "plain text"}
        out = execution._execute_code_step("SPACE", STEP, dict(resolved))
        check("scalar result wrapped as result key", out.get("result") == "plain text")
        check(
            "scalar wrap is addressable via $.result",
            execution._extract_path(out, "$.result") == "plain text",
        )

        # --- response_parameters binding works on wrapped output ---------------------
        bound: dict = {}
        execution._bind_response_parameters(
            out, [{"property_path": "$.result", "parameter": "msg"}], bound
        )
        check("response parameter binds from wrapped output", bound.get("msg") == "plain text")

        # --- runner failure envelope --------------------------------------------------
        runner_reply = {"ok": False, "outcome": "timeout", "error": "Execution exceeded the 30s time limit."}
        out = execution._execute_code_step("SPACE", STEP, dict(resolved))
        check("failure sets _ok False", out.get("_ok") is False)
        check("failure carries sanitized error", "time limit" in str(out.get("_error")))
        check("failure outcome recorded in audit", audits[-1]["detail"]["outcome"] == "timeout")

        # --- over-deep runner output is rejected --------------------------------------
        deep: object = "leaf"
        for _ in range(40):
            deep = [deep]
        runner_reply = {"ok": True, "outcome": "ok", "result": deep}
        out = execution._execute_code_step("SPACE", STEP, dict(resolved))
        check("over-deep output rejected", out.get("_ok") is False and "depth" in str(out.get("_error")))

        # --- missing resource ----------------------------------------------------------
        out = execution._execute_code_step(
            "SPACE", {"id": "ID_step2", "kind": "code", "resource_id": "ID_missing"}, {}
        )
        check("missing resource is a step error", out.get("_ok") is False)
        check("missing resource audited", audits[-1]["detail"]["outcome"] == "missing_resource")

        # --- kill switch ----------------------------------------------------------------
        os.environ["PONA_FLOW_CODE_EXEC_ENABLED"] = "0"
        before = len(runner_requests)
        out = execution._execute_code_step("SPACE", STEP, dict(resolved))
        check("kill switch blocks execution", out.get("_ok") is False)
        check("kill switch never reaches the runner", len(runner_requests) == before)
        check("kill switch audited as disabled", audits[-1]["detail"]["outcome"] == "disabled")

        # --- dispatch: _execute_step routes code steps -----------------------------------
        os.environ.pop("PONA_FLOW_CODE_EXEC_ENABLED", None)
        runner_reply = {"ok": True, "outcome": "ok", "result": {"routed": True}}
        out = execution._execute_step("SPACE", STEP, dict(resolved))
        check("_execute_step routes kind=code to the runner", out.get("routed") is True)

    finally:
        execution.resources.load_for_execution = saved_load
        execution_run._call_runner = saved_call
        execution.catalog.record_audit = saved_record
        execution.credentials.resolve = saved_resolve
        if saved_env is None:
            os.environ.pop("PONA_FLOW_CODE_EXEC_ENABLED", None)
        else:
            os.environ["PONA_FLOW_CODE_EXEC_ENABLED"] = saved_env

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All code-exec step checks passed.")


if __name__ == "__main__":
    main()
