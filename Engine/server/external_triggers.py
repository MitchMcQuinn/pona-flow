"""
External event triggers — inbound-webhook matching, payload mapping, and dispatch.

Purpose in the project
----------------------
Time-bound ``events`` rows declare *when* sequences run (``triggers.py`` + the
scheduler). External events declare *what inbound payload* runs them: an event of
``type = 'external'`` is fired by an HTTP POST to its per-event ingest URL
(``/api/hooks/{ingest_token}``). This module is the payload-side analogue of
``triggers.py``:

- ``matches`` decides whether an inbound payload satisfies the event's filters.
- ``extract_params`` maps payload fields into the sequence parameters, layered over
  the event's fixed fallback parameters.
- ``dispatch_external_event`` runs the event's target sequences, mirroring the
  scheduler's ``_fire_event`` but driven by a payload instead of a timer. It reuses
  ``sequence_service.run_sequence_once`` so the run engine stays the single source of
  truth (trigger ``external``).

It also owns the ingest token (URL secret) and the optional HMAC signature check used
by the receiver route in ``app.py``. Like ``triggers.py``/``agent_keys.py`` it knows
nothing about FastAPI.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sys
from typing import Any

from . import catalog, sequence_service

# Token embedded in the inbound URL; high-entropy so the URL itself is the secret.
_INGEST_TOKEN_PREFIX = "evt_"


def generate_ingest_token() -> str:
    """Mint a new, unguessable ingest token for an external event's inbound URL."""
    return _INGEST_TOKEN_PREFIX + secrets.token_urlsafe(32)


# --------------------------------------------------------------------------- paths


def resolve_path(payload: Any, path: str) -> Any:
    """Resolve a dot/bracket JSON path against ``payload`` (None when absent).

    Supports nested objects (``a.b.c``) and list indexing (``items[0].id`` or
    ``items.0.id``). A blank path returns the payload unchanged. Any miss (wrong key,
    out-of-range index, indexing a non-container) yields ``None`` rather than raising,
    so a malformed inbound payload can never break matching.
    """
    expr = (path or "").strip()
    if not expr:
        return payload
    # Normalize bracket indexing (``items[0]``) into dotted segments (``items.0``).
    expr = re.sub(r"\[(\d+)\]", r".\1", expr)
    current = payload
    for segment in expr.split("."):
        if segment == "":
            continue
        if isinstance(current, dict):
            current = current.get(segment)
        elif isinstance(current, list):
            try:
                current = current[int(segment)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current


# ------------------------------------------------------------------------- filters


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _filter_passes(actual: Any, operator: str, expected: Any) -> bool:
    op = (operator or "equals").strip().lower()
    if op == "exists":
        return actual is not None
    if op == "equals":
        return _as_text(actual) == _as_text(expected)
    if op == "contains":
        return _as_text(expected) in _as_text(actual)
    if op == "regex":
        try:
            return re.search(_as_text(expected), _as_text(actual)) is not None
        except re.error:
            return False
    # Unknown operator never matches (fail closed).
    return False


def matches(config: dict[str, Any] | None, payload: Any) -> bool:
    """Whether ``payload`` satisfies the event's filters.

    ``config`` is the event's ``external_package``. With no filters the event always
    fires (a bare inbound POST triggers it). ``combinator`` is ``AND`` (default) or
    ``OR`` across the filter list.
    """
    cfg = config if isinstance(config, dict) else {}
    filters = cfg.get("filters")
    if not isinstance(filters, list) or not filters:
        return True
    combinator = str(cfg.get("combinator") or "AND").strip().upper()
    results: list[bool] = []
    for f in filters:
        if not isinstance(f, dict):
            continue
        actual = resolve_path(payload, str(f.get("path") or ""))
        results.append(_filter_passes(actual, f.get("operator"), f.get("value")))
    if not results:
        return True
    return any(results) if combinator == "OR" else all(results)


# ------------------------------------------------------------------------ mapping


def extract_params(config: dict[str, Any] | None, payload: Any) -> dict[str, Any]:
    """Build the sequence parameters from a payload.

    Starts from the event's fixed ``parameters`` (fallback defaults) and overlays each
    ``param_mappings`` entry (``{source_path, parameter}``) resolved against the
    payload. Mapped values that resolve to ``None`` are skipped so they fall back to
    the fixed default (or the sequence step default downstream).
    """
    cfg = config if isinstance(config, dict) else {}
    params: dict[str, Any] = {}
    fixed = cfg.get("parameters")
    if isinstance(fixed, dict):
        params.update(fixed)
    mappings = cfg.get("param_mappings")
    if isinstance(mappings, list):
        for m in mappings:
            if not isinstance(m, dict):
                continue
            name = str(m.get("parameter") or "").strip()
            if not name:
                continue
            value = resolve_path(payload, str(m.get("source_path") or ""))
            if value is None:
                continue
            params[name] = value
    return params


# ------------------------------------------------------------------- verification


def verify_signature(secret: str | None, raw_body: bytes, signature: str | None) -> bool:
    """Verify an optional HMAC-SHA256 signature over the raw request body.

    When the event has no ``secret`` configured, verification is skipped (returns
    True). When a secret is set, the caller must send a matching hex HMAC-SHA256 of the
    raw body; comparison is constant-time. An optional ``sha256=`` prefix (GitHub/Slack
    style) is tolerated.
    """
    sec = (secret or "").strip()
    if not sec:
        return True
    provided = (signature or "").strip()
    if not provided:
        return False
    if "=" in provided:
        provided = provided.split("=", 1)[1].strip()
    expected = hmac.new(sec.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided)


# --------------------------------------------------------------------- dispatch


def dispatch_external_event(
    event: dict[str, Any], payload: Any, trigger: str = "external"
) -> dict[str, Any]:
    """Run an external event's target sequences with payload-derived parameters.

    Mirrors the scheduler's ``_fire_event``: per-sequence failures are isolated so one
    bad sequence cannot stop the rest. Each sequence is composed and run via
    ``sequence_service.run_sequence_once`` (the same seam the agent webhook and MCP use),
    recording an ``external`` audit row. Returns a small summary for the receiver.
    """
    space_id = str(event.get("space_id") or "").strip()
    event_id = str(event.get("id") or "").strip()
    config = event.get("external_package") or {}
    params = extract_params(config, payload)
    ran: list[str] = []
    failed: list[str] = []
    for seq_id in event.get("sequences") or []:
        seq = str(seq_id or "").strip()
        if not seq:
            continue
        try:
            sequence_service.run_sequence_once(
                space_id,
                seq,
                dict(params),
                trigger=trigger,
                principal_id=None,
            )
            ran.append(seq)
        except Exception as e:  # never let one sequence stop the rest
            failed.append(seq)
            sys.stderr.write(
                f"external trigger: event {event_id!r} sequence {seq!r} failed: {e}\n"
            )
    # Best-effort audit even when there are no target sequences, so the inbound hit is
    # recorded; run_sequence_once already audits each successful run individually.
    if not (event.get("sequences") or []):
        try:
            catalog.record_audit(
                space_id, [], event_id=event_id, trigger=trigger, principal_id=None
            )
        except Exception:  # auditing must never break the receiver
            pass
    return {"ran": ran, "failed": failed}
