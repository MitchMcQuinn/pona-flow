"""
Diagnostic test for timezone-aware (DST-correct) event rule evaluation.

Events may carry an IANA ``timezone`` in their package; all rule values (dates and
times) are then interpreted as local wall-clock time in that zone, and fire times are
computed DST-correctly. This verifies:

- A daily local time maps to different UTC instants in winter (EST) vs summer (EDT).
- ``next_activation`` lands on the correct UTC instant on each side of a DST change.
- Legacy packages (no timezone) and explicit "UTC" still evaluate in UTC.

US Eastern in 2026: EST = UTC-5 (winter), EDT = UTC-4 (summer); spring-forward is
Sun Mar 8 2026. So 09:00 local = 14:00 UTC before, 13:00 UTC after.

Run: `python tests/event-trigger-timezone.py` from the repo root.
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


# Bail out early with a clear message if the tz database is unavailable.
try:
    from zoneinfo import ZoneInfo

    ZoneInfo("America/New_York")
except Exception as e:  # pragma: no cover - environment guard
    print(f"[SKIP] zoneinfo/tzdata unavailable: {e}")
    sys.exit(0)


# "Every day at 09:00, America/New_York."
DAILY_NY = {
    "combinator": "OR",
    "timezone": "America/New_York",
    "groups": [{"combinator": "AND", "is_time": "09:00"}],
}

# Winter (EST = UTC-5): 09:00 local == 14:00 UTC.
check("Jan 09:00 NY active at 14:00 UTC", triggers.evaluate_package(DAILY_NY, dt(2026, 1, 15, 14, 0)))
check("Jan 09:00 NY NOT active at 13:00 UTC", not triggers.evaluate_package(DAILY_NY, dt(2026, 1, 15, 13, 0)))

# Summer (EDT = UTC-4): 09:00 local == 13:00 UTC.
check("Jul 09:00 NY active at 13:00 UTC", triggers.evaluate_package(DAILY_NY, dt(2026, 7, 15, 13, 0)))
check("Jul 09:00 NY NOT active at 14:00 UTC", not triggers.evaluate_package(DAILY_NY, dt(2026, 7, 15, 14, 0)))

# next_activation just before DST: next daily fire is still EST (14:00 UTC).
nxt_before = triggers.next_activation(DAILY_NY, dt(2026, 3, 6, 15, 0))
check("next daily NY fire pre-DST is Mar 7 14:00 UTC (EST)", nxt_before == dt(2026, 3, 7, 14, 0))

# next_activation just after DST: next daily fire is EDT (13:00 UTC).
nxt_after = triggers.next_activation(DAILY_NY, dt(2026, 3, 8, 15, 0))
check("next daily NY fire post-DST is Mar 9 13:00 UTC (EDT)", nxt_after == dt(2026, 3, 9, 13, 0))

# Weekly "Monday 09:00 NY" straddling the DST change (Mar 2 is EST, Mar 9 is EDT).
WEEKLY_NY = {
    "combinator": "OR",
    "timezone": "America/New_York",
    "groups": [{"combinator": "AND", "is_weekday": [1], "is_time": "09:00"}],
}
check("Mon Mar 2 09:00 EST active at 14:00 UTC", triggers.evaluate_package(WEEKLY_NY, dt(2026, 3, 2, 14, 0)))
check("Mon Mar 9 09:00 EDT active at 13:00 UTC", triggers.evaluate_package(WEEKLY_NY, dt(2026, 3, 9, 13, 0)))
nxt_week = triggers.next_activation(WEEKLY_NY, dt(2026, 3, 3, 0, 0))
check("weekly NY next after Tue Mar 3 -> Mon Mar 9 13:00 UTC", nxt_week == dt(2026, 3, 9, 13, 0))

# A non-DST zone with a half-hour offset (Asia/Kolkata = UTC+5:30): 09:00 local == 03:30 UTC.
KOLKATA = {
    "combinator": "OR",
    "timezone": "Asia/Kolkata",
    "groups": [{"combinator": "AND", "is_time": "09:00"}],
}
check("Kolkata 09:00 active at 03:30 UTC", triggers.evaluate_package(KOLKATA, dt(2026, 6, 1, 3, 30)))
check(
    "Kolkata next_activation from 04:00 UTC -> next day 03:30 UTC",
    triggers.next_activation(KOLKATA, dt(2026, 6, 1, 4, 0)) == dt(2026, 6, 2, 3, 30),
)

# Legacy package (no timezone) and explicit "UTC" both evaluate in UTC.
LEGACY = {"combinator": "OR", "groups": [{"combinator": "AND", "is_time": "09:00z"}]}
check("legacy (no tz) 09:00 active at 09:00 UTC", triggers.evaluate_package(LEGACY, dt(2026, 1, 15, 9, 0)))
check("legacy (no tz) 09:00 NOT active at 14:00 UTC", not triggers.evaluate_package(LEGACY, dt(2026, 1, 15, 14, 0)))

UTC_PKG = {"combinator": "OR", "timezone": "UTC", "groups": [{"combinator": "AND", "is_time": "09:00"}]}
check("explicit UTC 09:00 active at 09:00 UTC", triggers.evaluate_package(UTC_PKG, dt(2026, 1, 15, 9, 0)))

# An unknown timezone falls back to UTC rather than raising.
BAD_TZ = {"combinator": "OR", "timezone": "Mars/Olympus_Mons", "groups": [{"combinator": "AND", "is_time": "09:00"}]}
check("unknown tz falls back to UTC", triggers.evaluate_package(BAD_TZ, dt(2026, 1, 15, 9, 0)))

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("All timezone-aware event-trigger checks passed.")
