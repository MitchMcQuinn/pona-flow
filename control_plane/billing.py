"""Stripe Checkout and webhook signatures. No Stripe SDK."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.parse
import urllib.request
from typing import Any, Callable


class StripeError(RuntimeError):
    pass


def sign_payload(payload: bytes, secret: str, timestamp: int) -> str:
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + payload, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={mac}"


def verify_event(payload: bytes, header: str, secret: str, now: int | None = None, tolerance: int = 300) -> dict[str, Any]:
    if not secret:
        raise StripeError("STRIPE_WEBHOOK_SECRET is not set")
    parts: dict[str, list[str]] = {}
    for piece in (header or "").split(","):
        if "=" not in piece:
            continue
        key, value = piece.split("=", 1)
        parts.setdefault(key.strip(), []).append(value.strip())
    timestamps = parts.get("t") or []
    signatures = parts.get("v1") or []
    if not timestamps or not signatures:
        raise StripeError("missing signature")
    try:
        timestamp = int(timestamps[0])
    except ValueError as exc:
        raise StripeError("missing signature") from exc
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance:
        raise StripeError("signature is stale")
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + payload,
        hashlib.sha256,
    ).hexdigest()
    if not any(hmac.compare_digest(expected, candidate) for candidate in signatures):
        raise StripeError("signature does not match")
    try:
        event = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise StripeError("invalid payload") from exc
    if not isinstance(event, dict):
        raise StripeError("invalid payload")
    return event


Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, bytes]]


def urllib_form(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, response.read()


def create_checkout(
    *,
    secret_key: str,
    price_id: str,
    success_url: str,
    cancel_url: str,
    customer_email: str,
    instance_id: str,
    account_id: str,
    transport: Transport | None = None,
) -> str:
    if not secret_key or not price_id:
        raise StripeError("Stripe price is not configured")
    form = {
        "mode": "subscription",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "customer_email": customer_email,
        "client_reference_id": instance_id,
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "metadata[instance_id]": instance_id,
        "metadata[account_id]": account_id,
        "subscription_data[metadata][instance_id]": instance_id,
    }
    body = urllib.parse.urlencode(form).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    send = transport or urllib_form
    status, raw = send("POST", "https://api.stripe.com/v1/checkout/sessions", headers, body)
    if status >= 400:
        raise StripeError(f"Stripe checkout failed (HTTP {status})")
    payload = json.loads(raw.decode("utf-8"))
    url = str(payload.get("url") or "")
    if not url:
        raise StripeError("Stripe checkout did not return a url")
    return url
