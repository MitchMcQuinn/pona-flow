"""
Clerk Backend API client for resolving principal identities (email + display name).

Why this exists
---------------
Clerk session JWTs only carry the user id (``sub``) unless a custom token template adds
more. The management UI (members list, instance principals) needs human-readable
identities for *every* principal, not just the signed-in one the browser can see via
``useUser``. This module calls Clerk's Backend API (``GET /v1/users/{id}``) with the
``CLERK_SECRET_KEY`` to fetch a primary email and a display name, and backfills them into
the local ``users`` table so subsequent reads are cheap.

Resilience: every function degrades gracefully. If no secret key is configured or a
request fails, lookups return ``None`` / no-op and the caller keeps the existing data.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import httpx

from . import config


def _display_name_from(user: dict[str, Any]) -> str | None:
    """Best-effort human label from a Clerk user payload."""
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    full = " ".join(p for p in (first, last) if p).strip()
    if full:
        return full
    username = (user.get("username") or "").strip()
    return username or None


def _primary_email_from(user: dict[str, Any]) -> str | None:
    """Resolve the user's primary email address from a Clerk user payload."""
    addresses = user.get("email_addresses")
    if not isinstance(addresses, list) or not addresses:
        return None
    primary_id = user.get("primary_email_address_id")
    if primary_id:
        for entry in addresses:
            if isinstance(entry, dict) and entry.get("id") == primary_id:
                email = (entry.get("email_address") or "").strip()
                if email:
                    return email
    # Fall back to the first address that has a value.
    for entry in addresses:
        if isinstance(entry, dict):
            email = (entry.get("email_address") or "").strip()
            if email:
                return email
    return None


def fetch_identity(clerk_user_id: str) -> dict[str, str | None] | None:
    """Fetch ``{"email", "name"}`` for a Clerk user, or ``None`` if unavailable.

    Returns ``None`` when Clerk is not configured or the request fails, so callers can
    treat enrichment as best-effort.
    """
    cid = (clerk_user_id or "").strip()
    secret = config.clerk_secret_key()
    if not cid or not secret:
        return None
    url = f"{config.clerk_api_base()}/users/{cid}"
    try:
        resp = httpx.get(
            url,
            headers={"Authorization": f"Bearer {secret}"},
            timeout=8.0,
        )
        if resp.status_code != 200:
            return None
        user = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(user, dict):
        return None
    return {"email": _primary_email_from(user), "name": _display_name_from(user)}


def enrich_missing_identities(conn: sqlite3.Connection, limit: int = 50) -> int:
    """Backfill email/display_name for user rows that still lack them. Returns count updated.

    Only touches Clerk-backed rows missing at least one identity field, so it is a no-op
    once everyone is resolved. Safe to call before listing members/principals.
    """
    if not config.clerk_secret_key():
        return 0
    try:
        rows = conn.execute(
            "SELECT id, clerk_user_id FROM users "
            "WHERE clerk_user_id IS NOT NULL AND clerk_user_id != '' "
            "  AND (email IS NULL OR email = '' OR display_name IS NULL OR display_name = '') "
            "LIMIT ?",
            (limit,),
        ).fetchall()
    except sqlite3.OperationalError:
        return 0
    updated = 0
    for row in rows:
        identity = fetch_identity(row["clerk_user_id"])
        if not identity:
            continue
        sets: list[str] = []
        args: list[Any] = []
        if identity.get("email"):
            sets.append("email = ?")
            args.append(identity["email"])
        if identity.get("name"):
            sets.append("display_name = ?")
            args.append(identity["name"])
        if not sets:
            continue
        args.append(row["id"])
        conn.execute(
            f"UPDATE users SET {', '.join(sets)}, modified_date = datetime('now') WHERE id = ?",
            args,
        )
        updated += 1
    if updated:
        conn.commit()
    return updated
