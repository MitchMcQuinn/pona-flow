"""Fleet callback from a hosted instance. Unset env does nothing."""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Callable

log = logging.getLogger("pona_flow.fleet")

Sender = Callable[[str, str, str, int], None]


def configured() -> bool:
    return bool(
        (os.environ.get("PONA_FLOW_FLEET_URL") or "").strip()
        and (os.environ.get("PONA_FLOW_FLEET_TOKEN") or "").strip()
        and (os.environ.get("PONA_FLOW_FLEET_INSTANCE_ID") or "").strip()
    )


def notify_event_count(sender: Sender | None = None) -> None:
    """Tell the control plane how many events exist. No-op unless fleet env is set."""
    if not configured():
        return
    url = (os.environ.get("PONA_FLOW_FLEET_URL") or "").strip().rstrip("/")
    token = (os.environ.get("PONA_FLOW_FLEET_TOKEN") or "").strip()
    instance_id = (os.environ.get("PONA_FLOW_FLEET_INSTANCE_ID") or "").strip()
    try:
        count = _event_count()
        (sender or _post)(url, token, instance_id, count)
    except Exception:
        log.warning("fleet presence callback failed")


def _event_count() -> int:
    from . import catalog

    return len(catalog.list_events())


def _post(url: str, token: str, instance_id: str, count: int) -> None:
    body = json.dumps({"event_count": count}).encode("utf-8")
    request = urllib.request.Request(
        f"{url}/api/internal/instances/{instance_id}/presence",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status >= 400:
                raise RuntimeError(f"HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}") from exc
