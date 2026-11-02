"""Suspend sandboxes at 7 days and delete volumes after the grace period."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from .db import Database
from .lifecycle import due_for_suspend, should_delete, suspend_fields
from .util import utcnow

log = logging.getLogger("pona_flow.control_plane.scheduler")


def tick(database: Database, fly: Any, now: datetime | None = None) -> dict[str, int]:
    moment = now or utcnow()
    suspended = 0
    deleted = 0
    for row in database.running_sandboxes():
        if not due_for_suspend(row, moment):
            continue
        _mode(fly, row, "suspended")
        database.update_instance(str(row["id"]), **suspend_fields(moment))
        suspended += 1
    for row in database.suspended_instances():
        if not should_delete(row, moment):
            continue
        app = str(row.get("app_name") or "")
        volume_id = str(row.get("volume_id") or "")
        if app and volume_id:
            try:
                fly.delete_volume(app, volume_id)
            except Exception:
                log.warning("volume delete failed for %s", app)
                continue
        if app:
            try:
                fly.delete_app(app)
            except Exception:
                log.warning("app delete failed for %s", app)
                continue
        database.update_instance(str(row["id"]), status="deleted")
        deleted += 1
    return {"suspended": suspended, "deleted": deleted}


def note_events(database: Database, fly: Any, instance: dict[str, Any], event_count: int) -> dict[str, Any]:
    """Record how many events exist and keep a sandbox awake while any are configured."""
    from .lifecycle import presence_fields, should_touch_machine

    fields = presence_fields(instance, event_count)
    updated = database.update_instance(str(instance["id"]), **fields)
    if should_touch_machine(instance):
        mode = "sleep" if fields["sleep_allowed"] else "on"
        _mode(fly, instance, mode)
    return updated


def _mode(fly: Any, row: dict[str, Any], mode: str) -> None:
    app = str(row.get("app_name") or "")
    machine_id = str(row.get("fly_machine_id") or "")
    if app and machine_id and hasattr(fly, "set_mode"):
        fly.set_mode(app, machine_id, mode)
