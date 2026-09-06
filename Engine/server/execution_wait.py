"""
Wait STEP and loop-delay parking: resolve duration/until/event and decide if a run is due.

The executor parks with ``status=waiting`` rather than sleeping. This module is the
pure decision side (clock + parameter resolution); persist/resume lives in
``execution_run``.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

# Matches authoring MAX_WAIT_SECONDS (30 days).
MAX_WAIT_SECONDS = 30 * 24 * 3600

_PARAM_EXACT = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]*$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def parse_iso(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def param_name(raw: Any) -> str | None:
    text = str(raw or "").strip()
    if not _PARAM_EXACT.match(text):
        return None
    return text[1:]


def _resolve_raw(raw: Any, resolved: dict[str, Any]) -> Any:
    name = param_name(raw)
    if name:
        return resolved.get(name)
    return raw


def duration_seconds(step: dict[str, Any], resolved: dict[str, Any]) -> int:
    raw = _resolve_raw(step.get("duration_seconds"), resolved)
    if raw is None or raw == "":
        return 0
    try:
        seconds = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        raise ValueError("Wait duration must be a number of seconds (or $parameter).")
    if seconds < 0:
        raise ValueError("Wait duration cannot be negative.")
    if seconds > MAX_WAIT_SECONDS:
        raise ValueError("Wait duration cannot exceed 30 days.")
    return seconds


def until_datetime(step: dict[str, Any], resolved: dict[str, Any]) -> datetime | None:
    raw = _resolve_raw(step.get("until"), resolved)
    if raw is None or str(raw).strip() == "":
        return None
    parsed = parse_iso(raw)
    if parsed is None:
        raise ValueError("Wait-until must be an ISO-8601 datetime (or $parameter).")
    return parsed


def wait_due(wait: dict[str, Any] | None, now: datetime | None = None) -> bool:
    """True when a parked wait should resume."""
    spec = wait if isinstance(wait, dict) else {}
    if not spec:
        return True
    if spec.get("released"):
        return True
    kind = str(spec.get("kind") or "")
    if kind == "event":
        return False
    until = parse_iso(spec.get("until"))
    if until is None:
        return True
    return until <= (now or now_utc())


def park_spec_for_step(
    step: dict[str, Any], resolved: dict[str, Any], now: datetime | None = None
) -> dict[str, Any] | None:
    """
    Build ``progress.wait`` for a wait STEP, or ``None`` when the wait is already over
    (zero duration / until in the past) and the step should continue immediately.
    """
    clock = now or now_utc()
    mode = str(step.get("wait_mode") or "duration").strip() or "duration"
    if mode == "event":
        event_id = str(step.get("event_id") or "").strip()
        if not event_id:
            raise ValueError("Wait-for-event needs an Event from this space.")
        return {"kind": "event", "event_id": event_id}
    if mode == "until":
        until = until_datetime(step, resolved)
        if until is None:
            raise ValueError("Wait-until needs a datetime (or $parameter).")
        if until <= clock:
            return None
        return {"kind": "until", "until": isoformat(until)}
    seconds = duration_seconds(step, resolved)
    if seconds <= 0:
        return None
    until = clock + timedelta(seconds=seconds)
    return {"kind": "duration", "until": isoformat(until)}


def park_spec_for_loop_delay(delay_seconds: int, now: datetime | None = None) -> dict[str, Any] | None:
    if delay_seconds <= 0:
        return None
    if delay_seconds > MAX_WAIT_SECONDS:
        delay_seconds = MAX_WAIT_SECONDS
    clock = now or now_utc()
    return {
        "kind": "loop_delay",
        "until": isoformat(clock + timedelta(seconds=delay_seconds)),
    }


def waiting_payload(
    state_id: str, wait: dict[str, Any], *, step_id: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "status": "waiting",
        "state_id": state_id,
        "reason": str(wait.get("kind") or "duration"),
    }
    if wait.get("until"):
        out["wake_at"] = wait.get("until")
    if wait.get("event_id"):
        out["event_id"] = wait.get("event_id")
    if step_id:
        out["step_id"] = step_id
    return out
