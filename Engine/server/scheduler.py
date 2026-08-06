"""
In-process event scheduler.

Purpose in the project
----------------------
Time-bound ``events`` rows declare *when* one or more sequences should run. This
module runs inside the FastAPI process (started/stopped on the app lifespan) and:

- On startup, checks every enabled event's stored timer. If its ``next_fire_at`` is
  already in the past, a firing was missed while the server was down, so the event's
  ``recovery_sequences`` are run immediately. Each event's next fire time is then
  (re)computed and persisted.
- In a background loop, sleeps until the earliest upcoming ``next_fire_at`` and, when
  an event is due, runs its ``sequences``, records ``last_fired_at``, and reschedules.

The loop reuses the existing execution pipeline (``execution.compose_and_store`` +
``execution.run_execution``) so triggered runs behave exactly like manual ones, and
every run is written to ``audit_log`` (with trigger ``event`` / ``recovery``).

Blocking work (SQLite, Neo4j, outbound HTTP) is dispatched via ``asyncio.to_thread``
so the event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from typing import Any, Optional

from . import catalog, execution, triggers

# Upper bound on how long the loop sleeps between checks. Bounds responsiveness to
# clock changes and acts as a safety net even though create/edit/delete signal a wake.
_MAX_SLEEP_SECONDS = 30.0
_MIN_SLEEP_SECONDS = 0.5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def _parse_iso(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _run_one_sequence(
    space_id: str, seq_id: str, params: dict[str, Any], trigger: str, event_id: str
) -> None:
    composed = execution.compose_and_store(space_id, seq_id)
    state_id = str(composed.get("state_id") or "")
    if not state_id:
        return
    execution.run_execution(
        space_id, state_id, dict(params or {}), trigger=trigger, event_id=event_id
    )


def _fire_event(event: dict[str, Any], trigger: str) -> None:
    """Run an event's target (or recovery) sequences. Per-sequence failures are isolated."""
    space_id = str(event.get("space_id") or "").strip()
    event_id = str(event.get("id") or "").strip()
    if not space_id:
        return
    package = event.get("event_package") or {}
    params = package.get("parameters") if isinstance(package, dict) else {}
    if not isinstance(params, dict):
        params = {}
    key = "recovery_sequences" if trigger == "recovery" else "sequences"
    for seq_id in event.get(key) or []:
        seq = str(seq_id or "").strip()
        if not seq:
            continue
        try:
            _run_one_sequence(space_id, seq, params, trigger, event_id)
        except Exception as e:  # never let one sequence stop the rest / the loop
            sys.stderr.write(
                f"scheduler: event {event_id!r} sequence {seq!r} failed: {e}\n"
            )


def _compute_next(event: dict[str, Any], after: datetime) -> Optional[datetime]:
    return triggers.next_activation(event.get("event_package") or {}, after)


def _store_timers(
    event_id: str, last_fired_at: Optional[str], next_fire: Optional[datetime]
) -> None:
    catalog.update_event_timers(
        event_id,
        {"next_fire_at": _iso(next_fire), "last_fired_at": last_fired_at},
    )


def _active_time_events() -> list[dict[str, Any]]:
    return [
        e
        for e in catalog.list_events()
        if e.get("enabled") and (e.get("type") or "time") == "time"
    ]


def _startup_recovery() -> None:
    """Run recovery sequences for any timer missed while the server was down."""
    now = _now()
    for event in _active_time_events():
        timers = event.get("timers") or {}
        next_fire = _parse_iso(timers.get("next_fire_at"))
        if next_fire is not None and next_fire <= now:
            sys.stderr.write(
                f"scheduler: missed fire for event {event.get('id')!r} "
                f"(due {next_fire.isoformat()}); running recovery sequences\n"
            )
            _fire_event(event, trigger="recovery")
        # Recompute the next fire time from now so we don't immediately re-fire it.
        upcoming = _compute_next(event, now)
        _store_timers(str(event.get("id") or ""), timers.get("last_fired_at"), upcoming)


def _tick() -> float:
    """Fire any due events and return how many seconds to sleep before the next check."""
    now = _now()
    earliest: Optional[datetime] = None
    for event in _active_time_events():
        event_id = str(event.get("id") or "")
        timers = event.get("timers") or {}
        next_fire = _parse_iso(timers.get("next_fire_at"))
        last_fired = timers.get("last_fired_at")

        if next_fire is None:
            next_fire = _compute_next(event, now)
            _store_timers(event_id, last_fired, next_fire)

        if next_fire is not None and next_fire <= now:
            _fire_event(event, trigger="event")
            last_fired = _iso(now)
            next_fire = _compute_next(event, now)
            _store_timers(event_id, last_fired, next_fire)

        if next_fire is not None and (earliest is None or next_fire < earliest):
            earliest = next_fire

    if earliest is None:
        return _MAX_SLEEP_SECONDS
    delta = (earliest - _now()).total_seconds()
    return max(_MIN_SLEEP_SECONDS, min(delta, _MAX_SLEEP_SECONDS))


class Scheduler:
    """Owns the background asyncio task and a wake signal for create/edit/delete."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._stopped = False

    def wake(self) -> None:
        self._wake.set()

    async def start(self) -> None:
        self._stopped = False
        try:
            await asyncio.to_thread(_startup_recovery)
        except Exception as e:
            sys.stderr.write(f"scheduler: startup recovery failed: {e}\n")
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopped = True
        self.wake()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while not self._stopped:
            self._wake.clear()
            try:
                sleep_for = await asyncio.to_thread(_tick)
            except Exception as e:
                sys.stderr.write(f"scheduler: tick error: {e}\n")
                sleep_for = _MAX_SLEEP_SECONDS
            if self._stopped:
                break
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=sleep_for)
            except asyncio.TimeoutError:
                pass


_INSTANCE: Optional[Scheduler] = None


async def start() -> None:
    """Create and start the singleton scheduler (called on app startup)."""
    global _INSTANCE
    if _INSTANCE is not None:
        return
    _INSTANCE = Scheduler()
    await _INSTANCE.start()


async def stop() -> None:
    """Stop and clear the singleton scheduler (called on app shutdown)."""
    global _INSTANCE
    if _INSTANCE is None:
        return
    await _INSTANCE.stop()
    _INSTANCE = None


def request_reload() -> None:
    """Wake the loop so a newly created/edited/deleted event is picked up at once."""
    if _INSTANCE is not None:
        _INSTANCE.wake()
