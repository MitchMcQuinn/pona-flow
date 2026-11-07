"""A simulated event saved with an empty schedule still exposes groups as a list.

The event editor reads event_package.groups.length. An agent-created simulated
event stores event_package as {}.

Run (from pona-flow/):
    .venv/bin/python tests/event-package-shape.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server.catalog import _event_row_to_dict  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


def row(event_package: dict) -> tuple:
    return (
        "EV",
        "demo",
        "Simulated Ecosystem Tick Event",
        "simulated",
        1,
        json.dumps(event_package),
        "{}",
        "[]",
        "{}",
        "[]",
        "2026-01-01",
        "2026-01-01",
        "{}",
        None,
        None,
    )


empty = _event_row_to_dict(row({}))
check("empty package groups is a list", empty["event_package"]["groups"] == [])
check("empty package parameters is an object", empty["event_package"]["parameters"] == {})

scheduled = _event_row_to_dict(
    row({"combinator": "AND", "groups": [{"is_time": "18:00"}], "parameters": {"n": 1}, "timezone": "UTC"})
)
check("existing groups are kept", scheduled["event_package"]["groups"] == [{"is_time": "18:00"}])
check("existing combinator is kept", scheduled["event_package"]["combinator"] == "AND")
check("existing parameters are kept", scheduled["event_package"]["parameters"] == {"n": 1})

if failures:
    print(f"\n{len(failures)} failed")
    sys.exit(1)
print("\nevent-package-shape: ok")
