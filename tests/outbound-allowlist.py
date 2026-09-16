"""
Diagnostic test for D7 outbound URL allowlist vs private/loopback blocking.

Covers:
  - empty allowlist still rejects loopback;
  - a host on PONA_FLOW_OUTBOUND_ALLOWLIST may be loopback;
  - a host not on a non-empty allowlist is rejected even if public.

No network beyond local getaddrinfo. Run:
    .venv/bin/python tests/outbound-allowlist.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.pop("PONA_FLOW_OUTBOUND_ALLOWLIST", None)
os.environ.pop("PONA_FLOW_ALLOW_PRIVATE_OUTBOUND", None)

from Engine.server import execution_run as run  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def expect_error(endpoint: str) -> str:
    try:
        run._validate_outbound_url(endpoint)
        return ""
    except ValueError as e:
        return str(e)


os.environ.pop("PONA_FLOW_OUTBOUND_ALLOWLIST", None)
err = expect_error("http://127.0.0.1:8090/configs/x/generate")
check("empty allowlist rejects loopback", "blocked address" in err)

os.environ["PONA_FLOW_OUTBOUND_ALLOWLIST"] = "127.0.0.1"
try:
    run._validate_outbound_url("http://127.0.0.1:8090/configs/x/generate")
    check("allowlisted loopback is accepted", True)
except ValueError as e:
    check("allowlisted loopback is accepted", False)
    print(f"      {e}")

err = expect_error("http://localhost:8090/configs/x/generate")
check(
    "localhost not on 127.0.0.1 allowlist is rejected",
    "not in the outbound allowlist" in err,
)

os.environ["PONA_FLOW_OUTBOUND_ALLOWLIST"] = "example.com"
err = expect_error("http://127.0.0.1:8090/health")
check(
    "loopback rejected when allowlist is a public host",
    "not in the outbound allowlist" in err,
)

try:
    run._validate_outbound_url("http://example.com/ok")
    check("allowlisted public host is accepted", True)
except ValueError as e:
    check("allowlisted public host is accepted", False)
    print(f"      {e}")

os.environ.pop("PONA_FLOW_OUTBOUND_ALLOWLIST", None)
os.environ.pop("PONA_FLOW_ALLOW_PRIVATE_OUTBOUND", None)

if failures:
    print(f"\n{len(failures)} failure(s): {failures}")
    sys.exit(1)
print("\nAll outbound-allowlist checks passed.")
