"""Edition rules that do not talk to Fly or Stripe."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .util import (
    ACTIVE_SANDBOX_STATUSES,
    GRACE_DAYS,
    PUBLIC_SANDBOX_CODE,
    SANDBOX_DAYS,
    hash_token,
    plus_days,
)

CodeKind = str  # "sandbox" | "vip" | "empty" | "unknown"


def classify_code(code: str | None) -> CodeKind:
    text = (code or "").strip()
    if not text:
        return "empty"
    if text.lower() == PUBLIC_SANDBOX_CODE:
        return "sandbox"
    return "vip"


def sandbox_expiry(now: datetime) -> str:
    return plus_days(now, SANDBOX_DAYS)


def grace_deadline(now: datetime) -> str:
    return plus_days(now, GRACE_DAYS)


def sleep_allowed(tier: str, event_count: int) -> bool:
    """A sandbox may sleep only when it has no configured events."""
    return tier == "sandbox" and int(event_count or 0) <= 0


def machine_awake(tier: str, event_count: int) -> bool:
    """Basic and VIP stay on. A sandbox stays on while any event exists."""
    if tier in ("basic", "vip", "self_hosted"):
        return True
    if tier == "sandbox":
        return not sleep_allowed(tier, event_count)
    return True


def presence_fields(instance: dict[str, Any], event_count: int) -> dict[str, Any]:
    count = max(0, int(event_count))
    return {
        "event_count": count,
        "sleep_allowed": 1 if sleep_allowed(str(instance.get("tier") or ""), count) else 0,
    }


def should_touch_machine(instance: dict[str, Any]) -> bool:
    return str(instance.get("tier") or "") == "sandbox" and str(instance.get("status") or "") == "running"


def due_for_suspend(instance: dict[str, Any], now: datetime) -> bool:
    if str(instance.get("tier") or "") != "sandbox":
        return False
    if str(instance.get("status") or "") != "running":
        return False
    expires = instance.get("expires_at")
    if not expires:
        return False
    from .util import parse_iso

    moment = parse_iso(str(expires))
    return moment is not None and moment <= now


def suspend_fields(now: datetime) -> dict[str, Any]:
    return {
        "status": "suspended",
        "suspended_at": plus_days(now, 0),
        "delete_after": grace_deadline(now),
        "sleep_allowed": 0,
    }


def upgrade_fields() -> dict[str, Any]:
    """Stripe upgrade keeps the same app and pins it on."""
    return {
        "tier": "basic",
        "status": "running",
        "subscription_status": "active",
        "expires_at": None,
        "suspended_at": None,
        "delete_after": None,
        "sleep_allowed": 0,
        "error": None,
    }


def cancel_fields(now: datetime) -> dict[str, Any]:
    return {
        "subscription_status": "canceled",
        "status": "suspended",
        "suspended_at": plus_days(now, 0),
        "delete_after": grace_deadline(now),
        "sleep_allowed": 0,
    }


def should_delete(instance: dict[str, Any], now: datetime) -> bool:
    if str(instance.get("status") or "") != "suspended":
        return False
    if str(instance.get("tier") or "") == "vip":
        return False
    if str(instance.get("subscription_status") or "") == "active":
        return False
    deadline = instance.get("delete_after")
    if not deadline:
        return False
    from .util import parse_iso

    moment = parse_iso(str(deadline))
    return moment is not None and moment <= now


def sandbox_blocks_another(instance: dict[str, Any]) -> bool:
    return (
        str(instance.get("tier") or "") == "sandbox"
        and str(instance.get("status") or "") in ACTIVE_SANDBOX_STATUSES
    )


def vip_code_hash(code: str) -> str:
    return hash_token((code or "").strip())
