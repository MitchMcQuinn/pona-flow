"""
Sandbox harness (Python) — runs inside the disposable container.

Reads ``{"code": "..."}`` as JSON from stdin, executes the code, and writes a result
envelope to stdout after a sentinel delimiter:

    __PONA_FLOW_RESULT__{"ok": ..., "result": ..., "stdout": ..., "error": ...}

Result selection (the engine wraps anything non-object as {"result": <value>}):
  1. a top-level ``result`` variable, when JSON-serializable
  2. otherwise the whole stdout parsed as JSON, when it parses
  3. otherwise the last non-empty stdout line parsed as JSON, when it parses
  4. otherwise the raw stdout text (string)

This file provides NO security: isolation comes entirely from the container profile
(no network, non-root, read-only fs, cgroup limits, seccomp). Do not add "sandboxing"
logic here and do not weaken the container flags in exchange.
"""

import contextlib
import io
import json
import sys
import traceback

SENTINEL = "__PONA_FLOW_RESULT__"
MAX_STDOUT = 1024 * 1024  # mirror of the runner-side cap


def _jsonable(value):
    try:
        json.dumps(value)
        return True
    except (TypeError, ValueError):
        return False


def _pick_result(scope, stdout_text):
    if "result" in scope and _jsonable(scope["result"]):
        return scope["result"]
    text = stdout_text.strip()
    if text:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        last_line = text.splitlines()[-1].strip()
        if last_line:
            try:
                return json.loads(last_line)
            except json.JSONDecodeError:
                pass
    return stdout_text


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        request = {}
    code = request.get("code") or ""

    buffer = io.StringIO()
    scope = {"__name__": "__main__"}
    ok = True
    error = None
    try:
        with contextlib.redirect_stdout(buffer):
            exec(compile(code, "<step>", "exec"), scope)
    except BaseException:
        ok = False
        error = traceback.format_exc(limit=8)

    stdout_text = buffer.getvalue()
    truncated = len(stdout_text) > MAX_STDOUT
    stdout_text = stdout_text[:MAX_STDOUT]
    # The runner locates the envelope by the LAST sentinel occurrence; scrub user
    # output so a printed sentinel cannot confuse (or forge) the envelope parse.
    stdout_text = stdout_text.replace(SENTINEL, "__SENTINEL__")

    envelope = {
        "ok": ok,
        "result": _pick_result(scope, stdout_text) if ok else None,
        "stdout": stdout_text[-8192:],
        "error": error.replace(SENTINEL, "__SENTINEL__") if error else None,
        "truncated": truncated,
    }
    sys.stdout.write("\n" + SENTINEL + json.dumps(envelope))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
