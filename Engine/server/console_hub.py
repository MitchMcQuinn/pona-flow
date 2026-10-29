"""In-process fan-out for console refresh signals.

Time and external event fires run off the request thread (the scheduler, or a
webhook worker). Open ``GET /api/consoles/{id}/listen`` streams subscribe a
``queue.Queue``; ``notify_for_event`` wakes every console bound to that event.
Simulated tics do not publish here — the session runner refreshes the open
console itself.
"""

from __future__ import annotations

import queue
import threading

from . import catalog

_lock = threading.Lock()
_subscribers: dict[str, list[queue.Queue[str]]] = {}


def subscribe(console_id: str) -> queue.Queue[str]:
    """Register a listener for one console. The caller must ``unsubscribe``."""
    cid = (console_id or "").strip()
    q: queue.Queue[str] = queue.Queue()
    if not cid:
        return q
    with _lock:
        _subscribers.setdefault(cid, []).append(q)
    return q


def unsubscribe(console_id: str, subscriber: queue.Queue[str]) -> None:
    cid = (console_id or "").strip()
    with _lock:
        current = _subscribers.get(cid)
        if not current:
            return
        if subscriber in current:
            current.remove(subscriber)
        if not current:
            _subscribers.pop(cid, None)


def publish_console(console_id: str) -> int:
    """Wake listeners for one console. Returns how many were notified."""
    cid = (console_id or "").strip()
    if not cid:
        return 0
    with _lock:
        targets = list(_subscribers.get(cid) or [])
    for subscriber in targets:
        subscriber.put("refresh")
    return len(targets)


def notify_for_event(event_id: str) -> int:
    """Publish a refresh for every console triggered by this event."""
    eid = (event_id or "").strip()
    if not eid:
        return 0
    notified = 0
    for console in catalog.list_consoles_for_trigger(eid):
        notified += publish_console(str(console.get("id") or ""))
    return notified
