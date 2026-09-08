"""
Diagnostic test for HTTP/LLM outcome binding, per-step retry, and authorable timeouts.

Covers:
  - compose lists ``ok`` / ``status`` for HTTP and copies timeout/retry fields;
  - HTTP 500 binds ok=false and status=500; a POINTS_TO on ok=false is taken;
  - HTTP 200 binds ok=true; the success edge is taken;
  - successful query steps bind ok=True;
  - max_attempts=3 retries three times then continues with ok=false;
  - omitted max_attempts is a single attempt;
  - backoff_seconds>0 parks waiting/retry_backoff without visiting; scheduler wake retries;
  - authorable timeout is passed into urlopen; TimeoutError is a failed retryable attempt.

HTTP steps are stubbed via ``execution_run._execute_step`` except the timeout cases,
which call the real endpoint runner with a fake ``urlopen``. No Neo4j.

Run: ``python tests/step-outcome-retry-timeout.py`` from the repo root.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    config,
    execution,
    execution_call,
    execution_run,
    execution_wait,
    scheduler,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def http_step(step_id: str, targets=None, **fields: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": step_id,
        "query_id": "",
        "endpoint": "https://example.test/hook",
        "method": "POST",
        "parameters": [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
    }
    row.update(fields)
    return row


def query_step(step_id: str, targets=None) -> dict[str, Any]:
    return {
        "id": step_id,
        "query_id": f"Q_{step_id}",
        "endpoint": "",
        "parameters": [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
    }


def pkg(steps: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    package: dict[str, Any] = {
        "steps": steps,
        "response_parameters": extra.pop("response_parameters", []),
        "sequence_query_id": extra.pop("sequence_query_id", "SEQ_OUTCOME"),
        "space_id": extra.pop("space_id", "SP_TEST"),
        "owner_id": extra.pop("owner_id", "userA"),
    }
    package.update(extra)
    return package


def expire_wait(state_id: str) -> None:
    row = catalog.fetch_state_package(state_id) or {}
    progress = dict(row.get("progress") or {})
    wait = dict(progress.get("wait") or {})
    wait["until"] = "2000-01-01T00:00:00+00:00"
    progress["wait"] = wait
    catalog.update_state_progress(state_id, progress)


tmpdir = tempfile.mkdtemp(prefix="pona-flow-outcome-test-")
tmp_db = Path(tmpdir) / "data.db"
_original_path = config.catalog_sqlite_path
config.catalog_sqlite_path = lambda: tmp_db  # type: ignore[assignment]

_original_execute = execution_run._execute_step
_original_validate = execution_run._validate_outbound_url
_original_urlopen = execution_run.urllib.request.urlopen
_original_run_config = execution_run.local_llms.run_config

http_calls: list[dict[str, Any]] = []
canned: dict[str, Any] = {}


def fake_execute_step(space_id: str, step_row: dict, resolved: dict) -> dict:
    step_id = str(step_row.get("id") or "")
    kind = str(step_row.get("kind") or "").strip()
    http_calls.append({"id": step_id, "kind": kind, "resolved": dict(resolved)})
    if kind == "wait":
        return _original_execute(space_id, step_row, resolved)
    payload = canned.get(step_id)
    if callable(payload):
        return payload(len([c for c in http_calls if c["id"] == step_id]))
    if isinstance(payload, dict):
        return dict(payload)
    if str(step_row.get("query_id") or "").strip():
        return {"records": []}
    return {"_ok": True, "_status": 200}


execution_run._execute_step = fake_execute_step  # type: ignore[assignment]


def run(package: dict, params=None) -> tuple[dict, str]:
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    result = execution.run_execution("SP_TEST", state_id, params=params or {}, trigger="manual")
    return result, state_id


try:
    # --- compose: aliases and call policy --------------------------------------
    built = execution._build_step(
        "H",
        {
            "payload": {
                "endpoint": "https://example.test/hook",
                "method": "POST",
                "timeout_seconds": 12,
                "max_attempts": 3,
                "backoff_seconds": 5,
            },
            "parameters": [],
        },
        {},
    )
    check("compose copies timeout_seconds", built.get("timeout_seconds") == 12)
    check("compose copies max_attempts", built.get("max_attempts") == 3)
    check("compose copies backoff_seconds", built.get("backoff_seconds") == 5)

    omitted = execution._build_step(
        "H0",
        {"payload": {"endpoint": "https://example.test/hook"}, "parameters": []},
        {},
    )
    check("compose omits default max_attempts", "max_attempts" not in omitted)
    check("compose omits default timeout", "timeout_seconds" not in omitted)

    llm_built = execution._build_step(
        "L",
        {
            "payload": {
                "kind": "local_llm",
                "config_id": "CFG",
                "timeout_seconds": 90,
                "max_attempts": 2,
            },
            "parameters": [],
        },
        {},
    )
    check("compose copies LLM timeout_seconds", llm_built.get("timeout_seconds") == 90)
    check("compose copies LLM max_attempts", llm_built.get("max_attempts") == 2)

    http_aliases = execution._step_return_aliases(
        {"endpoint": "https://example.test/hook"}, lambda *_: None
    )
    check("HTTP available_parameters includes ok", "ok" in http_aliases)
    check("HTTP available_parameters includes status", "status" in http_aliases)

    llm_aliases = execution._step_return_aliases(
        {"kind": "local_llm", "config_id": "CFG"}, lambda *_: None
    )
    check("LLM available_parameters includes ok", "ok" in llm_aliases)
    check("LLM available_parameters omits status", "status" not in llm_aliases)

    wait_aliases = execution._step_return_aliases(
        {"kind": "wait", "mode": "duration", "duration_seconds": 1}, lambda *_: None
    )
    check("wait available_parameters includes ok", "ok" in wait_aliases)

    join_aliases = execution._step_return_aliases({"kind": "join"}, lambda *_: None)
    check("join available_parameters includes ok", "ok" in join_aliases)
    check("join available_parameters omits status", "status" not in join_aliases)

    query_aliases = execution._step_return_aliases(
        {"query_id": "Q1"},
        lambda _qid: {"kind": "operation", "cypher": ["RETURN 1 AS n"]},
    )
    check("query available_parameters includes RETURN alias", "n" in query_aliases)
    check("query available_parameters includes ok", "ok" in query_aliases)

    mapped = execution._step_return_aliases(
        {
            "endpoint": "https://example.test/hook",
            "response_parameters": [{"parameter": "shipment_id", "property_path": "id"}],
        },
        lambda *_: None,
    )
    check(
        "HTTP aliases list ok before mapped names",
        mapped[:2] == ["ok", "status"] and "shipment_id" in mapped,
    )

    check("HTTP default timeout is 30", execution_call.HTTP_DEFAULT_TIMEOUT_SECONDS == 30)
    check("LLM default timeout is 300", execution_call.LLM_DEFAULT_TIMEOUT_SECONDS == 300)
    check(
        "omitted max_attempts is 1",
        execution_call.max_attempts({}) == 1,
    )

    # --- HTTP 500 takes the false-ok edge --------------------------------------
    http_calls.clear()
    canned.clear()
    canned["H500"] = {"_ok": False, "_status": 500, "_error": "boom"}
    result, _ = run(pkg([http_step("H500")]))
    check("HTTP 500 run finishes", result.get("status") == "inactive")
    check("HTTP 500 binds ok=false", result.get("resolved", {}).get("ok") is False)
    check("HTTP 500 binds status=500", result.get("resolved", {}).get("status") == 500)

    http_calls.clear()
    result, _ = run(
        pkg(
            [
                http_step(
                    "H500",
                    [
                        {
                            "id": "FAIL",
                            "condition_parameter": "ok",
                            "condition_expected": False,
                        },
                        {
                            "id": "OK",
                            "condition_parameter": "ok",
                            "condition_expected": True,
                        },
                    ],
                ),
                query_step("FAIL"),
                query_step("OK"),
            ]
        )
    )
    check(
        "HTTP 500 takes the false-ok edge",
        [e.get("step_id") for e in result.get("executed") or []] == ["H500", "FAIL"],
    )

    # --- HTTP 200 takes the success edge ---------------------------------------
    http_calls.clear()
    canned.clear()
    canned["H200"] = {"_ok": True, "_status": 200}
    result, _ = run(pkg([http_step("H200")]))
    check("HTTP 200 binds ok=true", result.get("resolved", {}).get("ok") is True)
    check("HTTP 200 binds status=200", result.get("resolved", {}).get("status") == 200)

    http_calls.clear()
    result, _ = run(
        pkg(
            [
                http_step(
                    "H200",
                    [
                        {
                            "id": "FAIL",
                            "condition_parameter": "ok",
                            "condition_expected": False,
                        },
                        {
                            "id": "OK",
                            "condition_parameter": "ok",
                            "condition_expected": True,
                        },
                    ],
                ),
                query_step("FAIL"),
                query_step("OK"),
            ]
        )
    )
    check("HTTP 200 takes the success edge", [e.get("step_id") for e in result.get("executed") or []] == ["H200", "OK"])

    # --- successful query sets ok=True -----------------------------------------
    http_calls.clear()
    canned.clear()
    result, _ = run(pkg([query_step("QOK")]))
    check("successful query binds ok=True", result.get("resolved", {}).get("ok") is True)
    check("query does not invent status", "status" not in (result.get("resolved") or {}))

    # --- max_attempts=3 retries then continues with ok=false -------------------
    http_calls.clear()
    canned.clear()
    canned["HRETRY"] = lambda _n: {"_ok": False, "_status": 503}

    def fail_branch(step_id: str) -> dict[str, Any]:
        return {
            "id": step_id,
            "condition_parameter": "ok",
            "condition_expected": False,
        }

    result, _ = run(
        pkg(
            [
                http_step(
                    "HRETRY",
                    [fail_branch("ESCALATE")],
                    max_attempts=3,
                ),
                query_step("ESCALATE"),
            ]
        )
    )
    retry_calls = [c for c in http_calls if c["id"] == "HRETRY"]
    check("max_attempts=3 calls the step three times", len(retry_calls) == 3)
    escalate = [c for c in http_calls if c["id"] == "ESCALATE"]
    check(
        "exhausted retries leave ok=false for the next step",
        bool(escalate) and escalate[0]["resolved"].get("ok") is False,
    )
    check(
        "exhausted retries continue the walk",
        [e.get("step_id") for e in result.get("executed") or []] == ["HRETRY", "ESCALATE"],
    )
    check(
        "step is visited once after attempts are exhausted",
        [e.get("step_id") for e in result.get("executed") or []].count("HRETRY") == 1,
    )

    # --- omitted max_attempts is a single attempt ------------------------------
    http_calls.clear()
    canned.clear()
    canned["HONCE"] = {"_ok": False, "_status": 500}
    result, _ = run(
        pkg(
            [
                http_step("HONCE", [fail_branch("AFTER")]),
                query_step("AFTER"),
            ]
        )
    )
    check(
        "omitted max_attempts is one attempt",
        len([c for c in http_calls if c["id"] == "HONCE"]) == 1,
    )
    check(
        "single failed attempt still continues",
        [e.get("step_id") for e in result.get("executed") or []] == ["HONCE", "AFTER"],
    )

    # --- parked backoff; scheduler wake performs the next attempt --------------
    http_calls.clear()
    canned.clear()
    canned["HBACK"] = lambda _n: {"_ok": False, "_status": 502}
    result, sid = run(
        pkg(
            [
                http_step(
                    "HBACK",
                    [fail_branch("DONE")],
                    max_attempts=3,
                    backoff_seconds=30,
                ),
                query_step("DONE"),
            ]
        )
    )
    check("backoff parks with waiting", result.get("status") == "waiting")
    check("backoff reason is retry_backoff", result.get("reason") == "retry_backoff")
    row = catalog.fetch_state_package(sid) or {}
    progress = row.get("progress") or {}
    wait = progress.get("wait") or {}
    check("parked retry is not visited", "HBACK" not in (progress.get("visited") or []))
    check("parked retry stays on the queue", progress.get("queue") == ["HBACK"])
    check("retry wait kind is retry_backoff", wait.get("kind") == "retry_backoff")
    check("retry wait stores the next attempt", wait.get("attempt") == 2)
    check("one attempt before the first park", len([c for c in http_calls if c["id"] == "HBACK"]) == 1)

    expire_wait(sid)
    scheduler._wake_waiting_runs(datetime.now(timezone.utc))
    row = catalog.fetch_state_package(sid) or {}
    progress = row.get("progress") or {}
    check(
        "scheduler wake retries without visiting yet",
        row.get("status") == "waiting" and "HBACK" not in (progress.get("visited") or []),
    )
    check("second attempt happened on wake", len([c for c in http_calls if c["id"] == "HBACK"]) == 2)
    check(
        "wake parks for attempt 3",
        ((progress.get("wait") or {}).get("attempt") == 3),
    )

    expire_wait(sid)
    resumed = execution.run_execution("SP_TEST", sid, params={})
    check("last failed attempt finishes the run", resumed.get("status") == "inactive")
    check("three attempts in total", len([c for c in http_calls if c["id"] == "HBACK"]) == 3)
    done = [c for c in http_calls if c["id"] == "DONE"]
    check(
        "parked retry leaves ok=false for the next step",
        bool(done) and done[0]["resolved"].get("ok") is False,
    )
    check(
        "walk continues after parked retries",
        [e.get("step_id") for e in resumed.get("executed") or []] == ["HBACK", "DONE"],
    )

    # --- in-thread retry (backoff 0) does not park -----------------------------
    http_calls.clear()
    canned.clear()
    canned["HNOW"] = lambda _n: {"_ok": False, "_status": 500}
    result, _ = run(
        pkg([http_step("HNOW", max_attempts=2, backoff_seconds=0)])
    )
    check("zero backoff does not park", result.get("status") == "inactive")
    check("zero backoff still retries in-thread", len(http_calls) == 2)

    # --- authorable timeout is passed into the HTTP call -----------------------
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    execution_run._validate_outbound_url = lambda _url: None  # type: ignore[assignment]
    captured_timeout: dict[str, Any] = {}

    class _FakeResp:
        status = 200

        def read(self) -> bytes:
            return b'{"ok": true}'

        def __enter__(self) -> "_FakeResp":
            return self

        def __exit__(self, *_a: object) -> bool:
            return False

    def fake_urlopen(_req: Any, timeout: Any = None) -> Any:
        captured_timeout["timeout"] = timeout
        if captured_timeout.get("raise"):
            captured_timeout["raises"] = captured_timeout.get("raises", 0) + 1
            raise TimeoutError()
        return _FakeResp()

    execution_run.urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]

    out = execution_run._execute_endpoint_step(
        "SP_TEST",
        {
            "endpoint": "https://example.test/hook",
            "method": "GET",
            "timeout_seconds": 7,
        },
        {},
    )
    check("authorable timeout is passed to urlopen", captured_timeout.get("timeout") == 7)
    check("successful timed call is ok", out.get("_ok") is True)

    default_out = execution_run._execute_endpoint_step(
        "SP_TEST",
        {"endpoint": "https://example.test/hook", "method": "GET"},
        {},
    )
    check("omitted HTTP timeout defaults to 30", captured_timeout.get("timeout") == 30)
    check("default-timeout call still succeeds", default_out.get("_ok") is True)

    captured_timeout["raise"] = True
    captured_timeout["raises"] = 0
    timed = execution_run._execute_endpoint_step(
        "SP_TEST",
        {
            "endpoint": "https://example.test/hook",
            "method": "GET",
            "timeout_seconds": 4,
        },
        {},
    )
    check("timeout is a failed attempt", timed.get("_ok") is False)
    check("timeout sets _error", "timed out" in str(timed.get("_error") or "").lower())
    check("timeout records status 0", timed.get("_status") == 0)

    execution_run._execute_step = fake_execute_step  # type: ignore[assignment]
    canned.clear()
    http_calls.clear()
    captured_timeout["raises"] = 0

    def timeout_then_bind(space_id: str, step_row: dict, resolved: dict) -> dict:
        if str(step_row.get("query_id") or "").strip():
            return {"records": []}
        http_calls.append({"id": str(step_row.get("id") or "")})
        return execution_run._execute_endpoint_step(space_id, step_row, resolved)

    execution_run._execute_step = timeout_then_bind  # type: ignore[assignment]
    result, _ = run(
        pkg(
            [
                http_step(
                    "HTIME",
                    timeout_seconds=4,
                    max_attempts=2,
                    backoff_seconds=0,
                )
            ]
        )
    )
    check("timeout retries when attempts remain", captured_timeout.get("raises") == 2)
    check("timeout retry ends with ok=false", result.get("resolved", {}).get("ok") is False)
    check("timeout retry binds status 0", result.get("resolved", {}).get("status") == 0)
    check(
        "timeout retry visits the step once",
        [e.get("step_id") for e in result.get("executed") or []] == ["HTIME"],
    )

    # --- Local LLM timeout is passed through -----------------------------------
    llm_timeout: dict[str, Any] = {}

    def fake_run_config(*_a: Any, **kwargs: Any) -> dict[str, Any]:
        llm_timeout.update(kwargs)
        return {
            "config_id": "CFG",
            "model": "m",
            "response": "hi",
            "parsed": None,
            "done_reason": "stop",
            "eval_count": 1,
        }

    execution_run.local_llms.run_config = fake_run_config  # type: ignore[assignment]
    llm_out = execution_run._execute_local_llm_step(
        "SP_TEST",
        {"kind": "local_llm", "config_id": "CFG", "timeout_seconds": 11},
        {"prompt": "hello"},
    )
    check("LLM success still sets _ok", llm_out.get("_ok") is True)
    check("LLM timeout_seconds is passed to run_config", llm_timeout.get("timeout_seconds") == 11)

    llm_timeout.clear()
    execution_run._execute_local_llm_step(
        "SP_TEST",
        {"kind": "local_llm", "config_id": "CFG"},
        {"prompt": "hello"},
    )
    check(
        "omitted LLM timeout defaults to 300",
        llm_timeout.get("timeout_seconds") == 300,
    )

    # --- wait step publishes ok=true -------------------------------------------
    execution_run._execute_step = fake_execute_step  # type: ignore[assignment]
    canned.clear()
    http_calls.clear()
    result, _ = run(
        pkg(
            [
                {
                    "id": "W0",
                    "query_id": "",
                    "kind": "wait",
                    "endpoint": "",
                    "parameters": [],
                    "next": [],
                    "wait_mode": "duration",
                    "duration_seconds": 0,
                }
            ]
        )
    )
    check("wait step binds ok=true", result.get("resolved", {}).get("ok") is True)

    # --- explicit response mapping can override ok -----------------------------
    canned.clear()
    http_calls.clear()
    canned["HOV"] = {"_ok": False, "_status": 500}
    result, _ = run(
        pkg(
            [http_step("HOV")],
            response_parameters=[{"parameter": "ok", "property_path": "_ok"}],
        )
    )
    # Mapping $._ok onto ok still yields false here; use a path that wins with a default.
    check(
        "auto-bound ok is present before mapping (false from transport)",
        result.get("resolved", {}).get("ok") is False,
    )

finally:
    execution_run._execute_step = _original_execute  # type: ignore[assignment]
    execution_run._validate_outbound_url = _original_validate  # type: ignore[assignment]
    execution_run.urllib.request.urlopen = _original_urlopen  # type: ignore[assignment]
    execution_run.local_llms.run_config = _original_run_config  # type: ignore[assignment]
    config.catalog_sqlite_path = _original_path  # type: ignore[assignment]


if failures:
    print(f"\n{len(failures)} failed:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("\nAll checks passed.")
