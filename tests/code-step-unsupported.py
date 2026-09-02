"""
Diagnostic test: leftover code-execution STEPs are refused, not sent to HTTP.

The sandbox runner is archived (Docs/code-execution/). Existing payloads with
kind "code" must fail clearly instead of falling through to an empty endpoint.

Run: ``.venv/bin/python tests/code-step-unsupported.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import execution  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(f"{name}: {detail}" if detail else name)


STEP = {"id": "ID_step1", "kind": "code", "resource_id": "ID_res1"}
out = execution._execute_code_step("SPACE", STEP, {})
check("stub returns not ok", out.get("_ok") is False, str(out))
check(
    "stub names the archived feature",
    "not supported" in str(out.get("_error") or "").lower(),
    str(out),
)

dispatched = execution._execute_step("SPACE", STEP, {})
check("dispatch refuses kind=code", dispatched.get("_ok") is False, str(dispatched))
check("dispatch does not look like HTTP", "_status" not in dispatched, str(dispatched))

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All code-step-unsupported checks passed.")
