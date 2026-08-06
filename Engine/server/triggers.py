"""
Time-bound event rule evaluation.

Purpose in the project
----------------------
An ``events`` row stores an ``event_package`` describing *when* the event is active
as a conditional rule tree. This module turns that declarative package into two
answers the scheduler needs:

- ``evaluate_package(package, dt)`` — is the event active at this exact UTC minute?
- ``next_activation(package, after)`` — what is the next UTC minute it fires?

Model
-----
A package has a global ``combinator`` ("AND" / "OR") and a list of ``groups``.
Each group has its own ``combinator`` plus rule elements:

  - ``is_weekday``      array of 1..7 (1 = Monday)
  - ``is_date_ordinal`` array of 1..31 (day of month)
  - ``is_date``         explicit ISO 8601 date
  - ``is_month``        array of 1..12
  - ``is_year``         array of 4-digit years
  - ``is_time``         explicit time of day, date-agnostic (e.g. "10:00z", UTC)

The five *date* elements select which calendar days match (combined by the group's
combinator over the non-null ones). ``is_time`` selects the time of day and is always
ANDed with the day match; when ``is_time`` is null the group fires at ``00:00``. A group
matches a minute when its day match holds and the minute equals the group's fire time.
Groups are then combined by the global combinator.

Timezone
--------
The package may carry a ``timezone`` field (an IANA name like ``"America/New_York"``).
When set, *all* rule elements — weekday/day/month/year/date and time-of-day — are
interpreted against local wall-clock time in that zone, and fire times are computed
DST-correctly (e.g. "every weekday at 09:00 local" lands at the right UTC instant on
both sides of a DST change). When ``timezone`` is absent / empty / ``"UTC"`` (legacy
packages), evaluation stays in UTC, matching the historical behavior. The vestigial
``z`` suffix on times is still tolerated but no longer implies UTC.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Optional

# How far ahead next_activation will scan before giving up (~5 years).
_HORIZON_DAYS = 366 * 5


def _package_zone(package: Any) -> tzinfo:
    """Resolve the package's IANA timezone, defaulting to UTC (and on any error)."""
    if isinstance(package, dict):
        name = str(package.get("timezone") or "").strip()
        if name and name.upper() != "UTC":
            try:
                from zoneinfo import ZoneInfo

                return ZoneInfo(name)
            except Exception:
                return timezone.utc
    return timezone.utc


def _to_utc_minute(dt: datetime) -> datetime:
    """Normalize a datetime to a tz-aware UTC value truncated to the minute."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(second=0, microsecond=0)


def _to_zone_minute(dt: datetime, zone: tzinfo) -> datetime:
    """Express a UTC (or naive-UTC) datetime as local wall time in ``zone``, to the minute."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(zone).replace(second=0, microsecond=0)


def _as_int_set(value: Any) -> Optional[set[int]]:
    """Coerce an element value into a set of ints. Accepts arrays or "1, 7" strings.

    Returns None when the element is absent/empty (i.e. "no constraint").
    """
    if value is None:
        return None
    items: list[Any]
    if isinstance(value, (list, tuple, set)):
        items = list(value)
    elif isinstance(value, str):
        items = [p.strip() for p in value.split(",")]
    else:
        items = [value]
    out: set[int] = set()
    for item in items:
        if item is None or (isinstance(item, str) and not item.strip()):
            continue
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out or None


def _parse_time(value: Any) -> Optional[tuple[int, int]]:
    """Parse a date-agnostic time of day into (hour, minute); None when invalid/empty."""
    if value is None:
        return None
    s = str(value).strip().lower()
    if s.endswith("z"):
        s = s[:-1].strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return None
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return (hour, minute)
    return None


def _parse_date(value: Any) -> Optional[date]:
    """Parse an explicit ISO 8601 date (date portion only); None when invalid/empty."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    head = s.replace("T", " ").split(" ")[0]
    try:
        return date.fromisoformat(head)
    except ValueError:
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
        except ValueError:
            return None


def _group_fire_time(group: dict[str, Any]) -> tuple[int, int]:
    """The (hour, minute) at which a group fires; defaults to midnight UTC."""
    return _parse_time(group.get("is_time")) or (0, 0)


def _date_match(group: dict[str, Any], dt: datetime) -> bool:
    """Evaluate the group's non-null date elements at dt under its combinator.

    A group with no active date elements imposes no day constraint (matches every day).
    """
    results: list[bool] = []

    weekdays = _as_int_set(group.get("is_weekday"))
    if weekdays is not None:
        results.append((dt.weekday() + 1) in weekdays)

    ordinals = _as_int_set(group.get("is_date_ordinal"))
    if ordinals is not None:
        results.append(dt.day in ordinals)

    months = _as_int_set(group.get("is_month"))
    if months is not None:
        results.append(dt.month in months)

    years = _as_int_set(group.get("is_year"))
    if years is not None:
        results.append(dt.year in years)

    explicit = _parse_date(group.get("is_date"))
    if explicit is not None:
        results.append(dt.date() == explicit)

    if not results:
        return True

    combinator = str(group.get("combinator") or "AND").strip().upper()
    if combinator == "OR":
        return any(results)
    return all(results)


def _group_matches(group: Any, dt: datetime) -> bool:
    if not isinstance(group, dict):
        return False
    if not _date_match(group, dt):
        return False
    hour, minute = _group_fire_time(group)
    return dt.hour == hour and dt.minute == minute


def evaluate_package(package: Any, dt_utc: datetime) -> bool:
    """Return True when the event package is active at the given instant.

    The instant is supplied in UTC and matched against the rules expressed in the
    package's timezone (local wall-clock), defaulting to UTC for legacy packages.
    """
    if not isinstance(package, dict):
        return False
    groups = [g for g in (package.get("groups") or []) if isinstance(g, dict)]
    if not groups:
        return False
    local = _to_zone_minute(dt_utc, _package_zone(package))
    results = [_group_matches(group, local) for group in groups]
    combinator = str(package.get("combinator") or "OR").strip().upper()
    if combinator == "AND":
        return all(results)
    return any(results)


def next_activation(package: Any, after_dt_utc: datetime) -> Optional[datetime]:
    """Return the next UTC minute strictly after ``after_dt_utc`` that fires, or None.

    Candidate fire times are the local times-of-day declared across the package's
    groups, so the scan walks day-by-day in the package's timezone. Each candidate is
    built as a local wall-clock instant and converted to UTC, which makes the result
    DST-correct. (A local time that falls in a spring-forward gap is skipped for that
    day, since ``evaluate_package`` re-checks the normalized instant.)
    """
    if not isinstance(package, dict):
        return None
    groups = [g for g in (package.get("groups") or []) if isinstance(g, dict)]
    if not groups:
        return None
    zone = _package_zone(package)
    after = _to_utc_minute(after_dt_utc)
    after_local = after.astimezone(zone)
    candidate_times = sorted({_group_fire_time(group) for group in groups})
    start_day = after_local.date()
    for day_offset in range(_HORIZON_DAYS):
        day = start_day + timedelta(days=day_offset)
        for hour, minute in candidate_times:
            candidate_local = datetime(
                day.year, day.month, day.day, hour, minute, tzinfo=zone
            )
            candidate = candidate_local.astimezone(timezone.utc).replace(
                second=0, microsecond=0
            )
            if candidate <= after:
                continue
            if evaluate_package(package, candidate):
                return candidate
    return None
