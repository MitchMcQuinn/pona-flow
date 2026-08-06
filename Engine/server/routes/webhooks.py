"""Agent-callable sequence webhooks + the unauthenticated external event receiver.

The sequence routes mirror the UI's compose+run flow as a single inbound call so
external callers (and the per-space MCP server) can drive a sequence directly. Both
accept either a Clerk JWT (humans) or an ``stg_`` agent key, and reuse the same
per-sequence RBAC authorization as the UI run path.

The ``/api/hooks/{ingest_token}`` receiver is unauthenticated by Clerk/agent key:
external services (Slack, Zapier, email->webhook gateways, ...) cannot hold those
credentials. The high-entropy ingest token in the URL is the secret; an optional
per-event HMAC shared secret adds payload-integrity verification. The handler is
deliberately defensive (never 500 on a bad payload) so a misbehaving provider can't
get its hook auto-disabled.
"""

from __future__ import annotations

import json
import sys

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, catalog, external_triggers, rbac, sequence_service
from ..auth import Principal
from ..http_utils import DOMAIN_ERRORS, bad_request, domain_500, json_body

router = APIRouter()


@router.get("/api/spaces/{space_id}/sequences")
def webhook_list_sequences(
    space_id: str,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    """Discovery: the runnable sequences in a space and their parameter schemas.

    This is the shape a per-space MCP server will expose as ``tools/list``; only
    sequences the principal is permitted to run are advertised."""
    sid = (space_id or "").strip()
    if not sid:
        raise bad_request("space_id is required")
    auth.require_space_access(principal, sid)
    with domain_500():
        all_sequences = sequence_service.list_runnable_sequences(sid)
    perms = auth.effective_permissions(principal, sid)
    runnable = [
        s
        for s in all_sequences
        if principal.is_superadmin
        or rbac.perms_allow_sequence(perms, str(s.get("id") or ""))
    ]
    return {"space_id": sid, "sequences": runnable}


@router.post("/api/spaces/{space_id}/sequences/{sequence_id}/run")
async def webhook_run_sequence(
    space_id: str,
    sequence_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal_or_agent),
):
    """Inbound webhook: compose+run a sequence in one call (or resume a paused run).

    Body: ``{"params": {...}, "state_id": "optional-resume-token"}``. Returns the
    executor's pending (with required ``parameters``) / inactive (with
    ``final_result``) shape verbatim — the human-in-the-loop contract."""
    sid = (space_id or "").strip()
    seq_id = (sequence_id or "").strip()
    if not sid or not seq_id:
        raise bad_request("space_id and sequence_id are required")
    body = await json_body(request)
    params = body.get("params")
    if not isinstance(params, dict):
        params = {}
    state_id = str(body.get("state_id") or "").strip() or None
    auth.require_sequence_run(principal, sid, seq_id)
    # When resuming, make sure the stored package belongs to the named sequence
    # (and the caller may run whatever sequence actually composed it).
    if state_id and not principal.is_superadmin:
        stored = catalog.fetch_state_package(state_id)
        stored_seq = str(
            (stored or {}).get("package", {}).get("sequence_query_id") or ""
        ).strip()
        if stored_seq and stored_seq != seq_id:
            auth.require_sequence_run(principal, sid, stored_seq)
    try:
        return sequence_service.run_sequence_once(
            sid,
            seq_id,
            params,
            state_id=state_id,
            owner_id=principal.user_id,
            trigger="webhook",
            principal_id=principal.user_id,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception as e:
        sys.stderr.write(f"sequence-webhook error: {e}\n")
        raise HTTPException(500, str(e))


@router.post("/api/hooks/{ingest_token}")
async def external_event_ingest(ingest_token: str, request: Request):
    """Inbound webhook: fire an external event's sequences from a posted payload.

    Resolves the event by ``ingest_token``, optionally verifies an HMAC signature
    (``X-Pona-Signature``) over the raw body, matches the payload against the
    event's filters, maps payload fields into sequence parameters, and dispatches
    the target sequences (trigger ``external``). Returns ``accepted`` / ``ignored``
    with a 200 so providers keep the hook enabled."""
    token = (ingest_token or "").strip()
    if not token:
        raise HTTPException(404, "unknown ingest token")
    try:
        event = catalog.get_event_by_ingest_token(token)
    except DOMAIN_ERRORS as e:
        sys.stderr.write(f"external-ingest lookup error: {e}\n")
        raise HTTPException(500, "lookup failed")
    if event is None or str(event.get("type") or "") != "external":
        raise HTTPException(404, "unknown ingest token")
    if not int(event.get("enabled") or 0):
        raise HTTPException(403, "event is disabled")

    config_pkg = event.get("external_package") or {}
    raw = await request.body()
    if not external_triggers.verify_signature(
        config_pkg.get("secret"), raw, request.headers.get("X-Pona-Signature")
    ):
        raise HTTPException(401, "invalid signature")

    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            # Tolerate non-JSON bodies (e.g. form-encoded) by exposing the raw text;
            # filters/mappings can still match on a single string payload.
            payload = {"raw": raw.decode("utf-8", "replace")}
    else:
        payload = {}

    try:
        if not external_triggers.matches(config_pkg, payload):
            return {"status": "ignored"}
        result = external_triggers.dispatch_external_event(event, payload)
    except Exception as e:  # never surface internals; keep the provider happy
        sys.stderr.write(f"external-ingest dispatch error: {e}\n")
        raise HTTPException(500, "dispatch failed")
    return {"status": "accepted", **result}
