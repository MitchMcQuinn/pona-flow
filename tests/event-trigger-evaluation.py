"""
Diagnostic test for time-bound event rule evaluation (server.triggers).

Verifies evaluate_package / next_activation against the worked example from the
feature spec: a global OR of two groups —
  - AND group: is_weekday [1,7] (Mon/Sun), is_time "10:00z", is_month [1,2,3]
  - OR group:  is_month [4] (fires at midnight, since is_time is null)
=> active on Mondays and Sundays at 10:00 UTC in Jan/Feb/Mar, and at the exact
   start of April (April 1, 00:00 UTC).

Run: `python tests/event-trigger-evaluation.py` from the repo root.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import triggers  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


def dt(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


PACKAGE = {
    "combinator": "OR",
    "groups": [
        {
            "combinator": "AND",
            "is_weekday": [1, 7],
            "is_date_ordinal": None,
            "is_date": None,
            "is_time": "10:00z",
            "is_month": [1, 2, 3],
            "is_year": None,
        },
        {
            "combinator": "OR",
            "is_weekday": None,
            "is_date_ordinal": None,
            "is_date": None,
            "is_time": None,
            "is_month": [4],
            "is_year": None,
        },
    ],
}

# 2026-01-05 is a Monday; 2026-01-04 is a Sunday; 2026-01-06 is a Tuesday.
check("Monday 10:00 Jan is active", triggers.evaluate_package(PACKAGE, dt(2026, 1, 5, 10, 0)))
check("Sunday 10:00 Jan is active", triggers.evaluate_package(PACKAGE, dt(2026, 1, 4, 10, 0)))
check("Tuesday 10:00 Jan is NOT active", not triggers.evaluate_package(PACKAGE, dt(2026, 1, 6, 10, 0)))
check("Monday 10:01 Jan is NOT active", not triggers.evaluate_package(PACKAGE, dt(2026, 1, 5, 10, 1)))
check("Monday 10:00 April is NOT active (month out of Jan-Mar)", not triggers.evaluate_package(PACKAGE, dt(2026, 4, 6, 10, 0)))
check("April 1 00:00 is active (group 2 midnight)", triggers.evaluate_package(PACKAGE, dt(2026, 4, 1, 0, 0)))
check("April 1 09:00 is NOT active (wrong time)", not triggers.evaluate_package(PACKAGE, dt(2026, 4, 1, 9, 0)))

# next_activation: from a Tuesday in Jan, the next fire is the following Sunday 10:00.
nxt = triggers.next_activation(PACKAGE, dt(2026, 1, 6, 12, 0))
check("next_activation after Tue Jan 6 -> Sun Jan 11 10:00", nxt == dt(2026, 1, 11, 10, 0))

# From late March, the next April midnight fire is April 1 00:00.
nxt2 = triggers.next_activation(PACKAGE, dt(2026, 3, 31, 12, 0))
check("next_activation from Mar 31 -> Apr 1 00:00", nxt2 == dt(2026, 4, 1, 0, 0))

# A daily time-only rule fires every day at the given time.
daily = {"combinator": "OR", "groups": [{"combinator": "AND", "is_time": "14:30z"}]}
check("daily 14:30 active", triggers.evaluate_package(daily, dt(2026, 7, 9, 14, 30)))
check("daily 14:30 not at 14:31", not triggers.evaluate_package(daily, dt(2026, 7, 9, 14, 31)))
check(
    "daily next_activation rolls to next day when past today's time",
    triggers.next_activation(daily, dt(2026, 7, 9, 15, 0)) == dt(2026, 7, 10, 14, 30),
)

# Comma-separated string element values are accepted (spec prose uses "1, 7").
str_pkg = {"combinator": "OR", "groups": [{"combinator": "AND", "is_weekday": "1, 7", "is_time": "10:00z"}]}
check("string weekday '1, 7' matches Monday", triggers.evaluate_package(str_pkg, dt(2026, 1, 5, 10, 0)))

# Empty / no-group packages never fire.
check("empty package never active", not triggers.evaluate_package({"combinator": "OR", "groups": []}, dt(2026, 1, 1)))
check("empty package next_activation is None", triggers.next_activation({"groups": []}, dt(2026, 1, 1)) is None)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("All event-trigger evaluation checks passed.")
