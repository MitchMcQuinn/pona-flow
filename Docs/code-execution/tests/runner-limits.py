"""
Diagnostic test for the sandbox runner's abuse controls (Engine/runner/runner.py).

Covers (Docker is NOT used — run_in_sandbox is monkeypatched):
- shared-secret auth: wrong/missing bearer token is rejected when a token is set;
- kill switch: PONA_FLOW_CODE_EXEC_ENABLED=0 refuses every execution (503/disabled);
- input validation: bad language, missing code, oversized code;
- per-space token-bucket rate limiting (429 rate_limited; spaces are independent);
- concurrency gate: bounded queue rejects with 429 when saturated;
- timeout clamping to PONA_FLOW_RUNNER_MAX_TIMEOUT;
- harness envelope parsing, including a sentinel-forging attempt in user output;
- docker run argument hardening flags (network/user/rootfs/cgroups/caps).

Run: ``.venv/bin/python tests/runner-limits.py`` from the repo root.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("PONA_FLOW_RUNNER_TOKEN", "")  # start unauthenticated (dev mode)

from fastapi.testclient import TestClient  # noqa: E402

from Engine.runner import runner  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def main() -> None:
    saved_run = runner.run_in_sandbox
    saved_bucket = runner._bucket
    saved_gate = runner._gate
    saved_env = dict(os.environ)

    captured: list[dict] = []

    async def fake_run(language, code, timeout_seconds, space_id):
        captured.append(
            {
                "language": language,
                "code": code,
                "timeout_seconds": timeout_seconds,
                "space_id": space_id,
            }
        )
        return {"ok": True, "outcome": "ok", "result": {"echo": True}, "duration_ms": 1}

    runner.run_in_sandbox = fake_run
    client = TestClient(runner.app)

    try:
        # --- happy path (no token configured -> dev mode accepts) ---------------------
        os.environ.pop("PONA_FLOW_CODE_EXEC_ENABLED", None)
        os.environ.pop("PONA_FLOW_RUNNER_TOKEN", None)
        r = client.post(
            "/execute",
            json={"language": "python", "code": "result = 1", "space_id": "SPACE_A"},
        )
        check("execute succeeds without token in dev mode", r.status_code == 200)
        check("envelope passed through", r.json().get("result") == {"echo": True})

        # --- auth ------------------------------------------------------------------------
        os.environ["PONA_FLOW_RUNNER_TOKEN"] = "topsecret"
        r = client.post(
            "/execute", json={"language": "python", "code": "x", "space_id": "S"}
        )
        check("missing token rejected (401)", r.status_code == 401)
        r = client.post(
            "/execute",
            json={"language": "python", "code": "x", "space_id": "S"},
            headers={"Authorization": "Bearer wrong"},
        )
        check("wrong token rejected (401)", r.status_code == 401)
        auth = {"Authorization": "Bearer topsecret"}
        r = client.post(
            "/execute",
            json={"language": "python", "code": "x", "space_id": "S"},
            headers=auth,
        )
        check("correct token accepted", r.status_code == 200)
        r = client.post("/admin/kill-all")
        check("admin kill switch requires token too", r.status_code == 401)

        # --- kill switch ---------------------------------------------------------------------
        os.environ["PONA_FLOW_CODE_EXEC_ENABLED"] = "0"
        r = client.post(
            "/execute",
            json={"language": "python", "code": "x", "space_id": "S"},
            headers=auth,
        )
        check("kill switch refuses execution (503)", r.status_code == 503)
        check("kill switch outcome is disabled", r.json().get("outcome") == "disabled")
        os.environ.pop("PONA_FLOW_CODE_EXEC_ENABLED", None)

        # --- input validation -------------------------------------------------------------------
        r = client.post(
            "/execute", json={"language": "ruby", "code": "x"}, headers=auth
        )
        check("unsupported language rejected (400)", r.status_code == 400)
        r = client.post(
            "/execute", json={"language": "python", "code": "  "}, headers=auth
        )
        check("empty code rejected (400)", r.status_code == 400)
        r = client.post(
            "/execute",
            json={"language": "python", "code": "x" * (513 * 1024)},
            headers=auth,
        )
        check("oversized code rejected (400)", r.status_code == 400)

        # --- timeout clamping ----------------------------------------------------------------------
        captured.clear()
        client.post(
            "/execute",
            json={
                "language": "python",
                "code": "x",
                "space_id": "S",
                "timeout_seconds": 9999,
            },
            headers=auth,
        )
        check("timeout clamped to the max", captured[-1]["timeout_seconds"] == 30)
        client.post(
            "/execute",
            json={
                "language": "python",
                "code": "x",
                "space_id": "S",
                "timeout_seconds": -5,
            },
            headers=auth,
        )
        check("timeout floored at 1s", captured[-1]["timeout_seconds"] == 1)

        # --- per-space rate limiting -----------------------------------------------------------------
        runner._bucket = runner.TokenBucket(3)
        statuses = [
            client.post(
                "/execute",
                json={"language": "python", "code": "x", "space_id": "BUSY"},
                headers=auth,
            ).status_code
            for _ in range(5)
        ]
        check(
            "burst allowed up to the per-minute rate",
            statuses[:3] == [200, 200, 200],
        )
        check("requests beyond the rate get 429", statuses[3:] == [429, 429])
        last = client.post(
            "/execute",
            json={"language": "python", "code": "x", "space_id": "BUSY"},
            headers=auth,
        )
        check("429 body says rate_limited", last.json().get("outcome") == "rate_limited")
        other = client.post(
            "/execute",
            json={"language": "python", "code": "x", "space_id": "QUIET"},
            headers=auth,
        )
        check("rate limit is per-space (other space unaffected)", other.status_code == 200)
        check(
            "token bucket refills over time",
            runner.TokenBucket(60).allow("k") is True,  # fresh bucket
        )
        bucket = runner.TokenBucket(60)
        for _ in range(60):
            bucket.allow("k")
        check("drained bucket denies", bucket.allow("k") is False)
        # Simulate the passage of one second: 60/min -> one token back.
        level, last_ts = bucket.tokens["k"]
        bucket.tokens["k"] = (level, last_ts - 1.0)
        check("bucket refills after waiting", bucket.allow("k") is True)

        # --- concurrency gate: bounded queue rejects when saturated -----------------------------------
        async def gate_test() -> tuple[int, int]:
            gate = runner.ExecutionGate(max_concurrency=1, queue_limit=1)
            release = asyncio.Event()

            async def hold():
                async with gate:
                    await release.wait()

            async def attempt():
                try:
                    async with gate:
                        return 200
                except Exception as e:
                    return getattr(e, "status_code", 500)

            holder = asyncio.create_task(hold())
            await asyncio.sleep(0.01)  # holder owns the semaphore
            waiter = asyncio.create_task(attempt())  # fills the queue (waiting=1)
            await asyncio.sleep(0.01)
            rejected = await attempt()  # queue full -> 429
            release.set()
            queued = await waiter
            await holder
            return rejected, queued

        rejected, queued = asyncio.new_event_loop().run_until_complete(gate_test())
        check("saturated queue rejects with 429", rejected == 429)
        check("queued request proceeds once a slot frees", queued == 200)

        # --- harness envelope parsing -------------------------------------------------------------------
        sentinel = runner._RESULT_SENTINEL.strip()
        good = f"user output\n{sentinel}" + json.dumps({"ok": True, "result": 7})
        env = runner._parse_harness_envelope(good)
        check("envelope parsed from stdout", env == {"ok": True, "result": 7})

        forged = (
            f"{sentinel}" + json.dumps({"ok": True, "result": "FORGED"}) + "\n"
            f"{sentinel}" + json.dumps({"ok": False, "error": "real"})
        )
        env = runner._parse_harness_envelope(forged)
        check(
            "last sentinel wins (user output cannot forge the result)",
            env == {"ok": False, "error": "real"},
        )
        check(
            "garbage after sentinel returns None",
            runner._parse_harness_envelope(f"{sentinel}not-json") is None,
        )
        check(
            "non-dict envelope returns None",
            runner._parse_harness_envelope(f"{sentinel}[1,2]") is None,
        )
        check(
            "missing sentinel returns None",
            runner._parse_harness_envelope("just text") is None,
        )

        # --- docker hardening flags ------------------------------------------------------------------------
        args = runner._docker_args("python", "test-container")
        joined = " ".join(args)
        for flag in (
            "--rm",
            "--network none",
            "--user 65534:65534",
            "--read-only",
            "noexec",
            "--memory",
            "--memory-swap",
            "--cpus",
            "--pids-limit",
            "--cap-drop ALL",
            "--security-opt no-new-privileges",
        ):
            check(f"docker args include {flag!r}", flag in joined)
        check("no volume mounts ever", "-v" not in args and "--volume" not in joined and "--mount" not in joined)
        check("javascript uses the node image", "node" in runner._docker_args("javascript", "c")[-1])

    finally:
        runner.run_in_sandbox = saved_run
        runner._bucket = saved_bucket
        runner._gate = saved_gate
        os.environ.clear()
        os.environ.update(saved_env)

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All runner abuse-control checks passed.")


if __name__ == "__main__":
    main()
