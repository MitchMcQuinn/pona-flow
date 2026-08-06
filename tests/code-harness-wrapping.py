"""
Diagnostic test for the sandbox harness scripts (Engine/runner/images/*/harness.*).

Runs the harnesses as plain local subprocesses (python3 always; node when installed —
the JS checks are skipped otherwise). This tests the stdin/stdout protocol and result
selection only; isolation itself is exercised in tests/runner-sandbox-docker.py.

Covers:
- result selection: `result` variable > whole-stdout JSON > last-line JSON > raw text;
- error capture (ok=false + traceback/message in `error`, never a crash);
- stdout capping (truncated flag) so output bombs cannot blow up the envelope;
- sentinel scrubbing: printing the sentinel cannot forge or corrupt the envelope.

Run: ``.venv/bin/python tests/code-harness-wrapping.py`` from the repo root.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_HARNESS = ROOT / "Engine/runner/images/python/harness.py"
JS_HARNESS = ROOT / "Engine/runner/images/node/harness.js"
SENTINEL = "__PONA_FLOW_RESULT__"

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def run_harness(cmd: list[str], code: str) -> dict:
    proc = subprocess.run(
        cmd,
        input=json.dumps({"code": code}),
        capture_output=True,
        text=True,
        timeout=60,
    )
    out = proc.stdout
    idx = out.rfind(SENTINEL)
    if idx < 0:
        raise AssertionError(f"no sentinel in harness output: {out[:500]!r}")
    return json.loads(out[idx + len(SENTINEL):])


def main() -> None:
    py = [sys.executable, str(PY_HARNESS)]

    # --- python: result selection ----------------------------------------------------
    env = run_harness(py, "result = {'a': 1, 'b': [1, 2]}")
    check("py: result variable wins", env["ok"] and env["result"] == {"a": 1, "b": [1, 2]})

    env = run_harness(py, "import json\nprint(json.dumps({'from': 'stdout'}))")
    check("py: whole-stdout JSON picked up", env["result"] == {"from": "stdout"})

    env = run_harness(py, "print('working...')\nprint('{\"last\": true}')")
    check("py: last-line JSON picked up", env["result"] == {"last": True})

    env = run_harness(py, "print('just text')")
    check("py: raw text fallback", env["ok"] and "just text" in str(env["result"]))

    env = run_harness(py, "result = object()\nprint('fine')")
    check("py: non-JSON result falls back to stdout", env["ok"] and env["result"] != None)  # noqa: E711

    # --- python: errors ----------------------------------------------------------------
    env = run_harness(py, "raise ValueError('boom')")
    check("py: exception -> ok false", env["ok"] is False)
    check("py: error carries the message", "boom" in str(env["error"]))
    check("py: failed run has null result", env["result"] is None)

    env = run_harness(py, "def broken(:")
    check("py: syntax error handled", env["ok"] is False and "SyntaxError" in str(env["error"]))

    # --- python: output cap ---------------------------------------------------------------
    env = run_harness(py, "print('x' * (2 * 1024 * 1024))")
    check("py: output bomb flagged truncated", env["truncated"] is True)
    check("py: stdout in envelope capped", len(env["stdout"]) <= 8192)

    # --- python: sentinel forging ------------------------------------------------------------
    forged = json.dumps({"ok": True, "result": "FORGED"})
    env = run_harness(py, f"print({(SENTINEL + forged)!r})\nresult = 'legit'")
    check("py: printed sentinel cannot forge the envelope", env["result"] == "legit")
    check("py: sentinel scrubbed from captured stdout", SENTINEL not in env["stdout"])

    env = run_harness(py, f"raise ValueError({SENTINEL!r})")
    check("py: sentinel scrubbed from error text", SENTINEL not in str(env["error"]))

    # --- javascript (skipped when node is not installed locally) ---------------------------
    node = shutil.which("node")
    if not node:
        print("[SKIP] node not installed locally — JS harness checks skipped")
    else:
        js = [node, str(JS_HARNESS)]
        env = run_harness(js, "globalThis.result = {a: 1};")
        check("js: result variable wins", env["ok"] and env["result"] == {"a": 1})

        env = run_harness(js, "console.log(JSON.stringify({from: 'stdout'}))")
        check("js: whole-stdout JSON picked up", env["result"] == {"from": "stdout"})

        env = run_harness(
            js,
            "globalThis.result = new Promise(r => setTimeout(() => r({waited: true}), 10));",
        )
        check("js: promise result awaited", env["result"] == {"waited": True})

        env = run_harness(js, "throw new Error('boom')")
        check("js: exception -> ok false", env["ok"] is False and "boom" in str(env["error"]))

        env = run_harness(js, "console.log('x'.repeat(2 * 1024 * 1024))")
        check("js: output bomb flagged truncated", env.get("truncated") is True)

        forged = json.dumps({"ok": True, "result": "FORGED"})
        env = run_harness(js, f"console.log({json.dumps(SENTINEL + forged)}); globalThis.result = 'legit';")
        check("js: printed sentinel cannot forge the envelope", env["result"] == "legit")

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All harness wrapping checks passed.")


if __name__ == "__main__":
    main()
