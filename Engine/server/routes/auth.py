"""Built-in authentication routes: status, first-run setup, login, logout, signup.

All routes except ``/api/auth/password`` are unauthenticated by nature (they are how a
browser *becomes* authenticated). They are inert in Clerk mode apart from ``status``,
which the UI calls first in every mode to decide how to boot.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse

from .. import auth, local_auth, rbac
from ..auth import Principal
from ..http_utils import bad_request, json_body

log = logging.getLogger("pona_flow.auth")

router = APIRouter()


def _require_local_mode() -> None:
    if local_auth.auth_mode() != local_auth.MODE_LOCAL:
        raise HTTPException(
            404, "Built-in accounts are disabled on this instance (PONA_FLOW_AUTH_MODE=clerk)."
        )


def _client_ip(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def _me_payload(principal: Principal) -> dict:
    return {
        "principal_id": principal.user_id,
        "email": principal.email,
        "display_name": principal.display_name,
        "principal_type": principal.principal_type,
        "is_superadmin": principal.is_superadmin,
        "can_create_spaces": principal.can_create_spaces,
        "timezone": principal.timezone,
        "auth_mode": local_auth.auth_mode(),
        "onboarding_tour_seen": rbac.onboarding_tour_seen_for(
            principal.principal_type, principal.user_id
        ),
    }


def _set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        key=local_auth.SESSION_COOKIE,
        value=token,
        max_age=int(local_auth.session_lifetime().total_seconds()),
        httponly=True,
        samesite="lax",
        secure=auth.session_cookie_secure(request),
        path="/",
    )


def _clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=local_auth.SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=auth.session_cookie_secure(request),
    )


def _signed_in_response(request: Request, user_id: str) -> JSONResponse:
    principal = auth.principal_from_user_id(user_id)
    if principal is None:
        raise HTTPException(500, "Account was created but could not be loaded.")
    token = local_auth.create_session(user_id)
    response = JSONResponse(_me_payload(principal))
    _set_session_cookie(response, request, token)
    return response


def _credentials_from(body: dict) -> tuple[str, str, str | None]:
    email = body.get("email")
    password = body.get("password")
    name = body.get("display_name")
    if not isinstance(email, str) or not isinstance(password, str):
        raise bad_request("email and password are required")
    if name is not None and not isinstance(name, str):
        raise bad_request("display_name must be a string")
    return email, password, name


@router.get("/api/auth/status")
def auth_status():
    """Unauthenticated: how the UI should boot (mode, setup needed, signup policy)."""
    return local_auth.public_status()


@router.post("/api/auth/setup")
async def auth_setup(request: Request):
    """Create the first account on a fresh instance. It becomes the instance admin.

    Only available while no local account exists; afterwards it returns 409 so the
    endpoint cannot be used to mint extra administrators.
    """
    _require_local_mode()
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    if not local_auth.setup_required():
        raise HTTPException(409, "Setup has already been completed.")
    email, password, name = _credentials_from(await json_body(request))
    try:
        user_id = local_auth.create_local_user(
            email, password, name, is_instance_admin=True, can_create_spaces=True
        )
    except ValueError as e:
        raise bad_request(str(e))
    rbac.claim_pending_invites(user_id, local_auth.normalize_email(email))
    log.info("Instance admin account created via first-run setup.")
    return _signed_in_response(request, user_id)


@router.post("/api/auth/login")
async def auth_login(request: Request):
    _require_local_mode()
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    body = await json_body(request)
    email = body.get("email")
    password = body.get("password")
    if not isinstance(email, str) or not isinstance(password, str):
        raise bad_request("email and password are required")
    ip = _client_ip(request)
    wait = local_auth.login_retry_after(ip, email)
    if wait > 0:
        raise HTTPException(
            429,
            "Too many sign-in attempts. Try again later.",
            headers={"Retry-After": str(wait)},
        )
    user_id = local_auth.authenticate(email, password)
    if not user_id:
        local_auth.record_login_failure(ip, email)
        raise HTTPException(401, "Incorrect email or password.")
    local_auth.record_login_success(ip, email)
    rbac.claim_pending_invites(user_id, email.strip())
    return _signed_in_response(request, user_id)


@router.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Revoke the current session (idempotent) and clear the cookie."""
    token = (request.cookies.get(local_auth.SESSION_COOKIE) or "").strip()
    if not token:
        authz = (request.headers.get("Authorization") or "").strip()
        if authz.lower().startswith("bearer "):
            token = authz[7:].strip()
    if token.startswith(local_auth.SESSION_PREFIX):
        local_auth.revoke_session(token)
    response = JSONResponse({"ok": True})
    _clear_session_cookie(response, request)
    return response


@router.post("/api/auth/signup")
async def auth_signup(request: Request):
    """Create an account after setup.

    Allowed when the email holds a pending space invite (the normal path: an admin
    invites a colleague, who then signs up) or when ``PONA_FLOW_ALLOW_OPEN_SIGNUP=1``.
    """
    _require_local_mode()
    if not auth.same_origin_request(request):
        raise HTTPException(403, "Cross-site request rejected.")
    if local_auth.setup_required():
        raise HTTPException(409, "This instance has not been set up yet.")
    email, password, name = _credentials_from(await json_body(request))
    try:
        normalized = local_auth.normalize_email(email)
    except ValueError as e:
        raise bad_request(str(e))
    if not (local_auth.open_signup_enabled() or local_auth.has_pending_invite(normalized)):
        raise HTTPException(
            403,
            "Sign-up is by invitation. Ask a space admin to invite this email address.",
        )
    try:
        user_id = local_auth.create_local_user(
            normalized,
            password,
            name,
            can_create_spaces=local_auth.signup_can_create_spaces(),
        )
    except ValueError as e:
        raise bad_request(str(e))
    rbac.claim_pending_invites(user_id, normalized)
    return _signed_in_response(request, user_id)


@router.post("/api/auth/password")
async def auth_change_password(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    """Change the signed-in user's password; signs out every other session."""
    _require_local_mode()
    body = await json_body(request)
    current = body.get("current_password")
    new = body.get("new_password")
    if not isinstance(current, str) or not isinstance(new, str):
        raise bad_request("current_password and new_password are required")
    if not local_auth.verify_user_password(principal.user_id, current):
        raise HTTPException(401, "Current password is incorrect.")
    try:
        local_auth.set_password(principal.user_id, new)
    except ValueError as e:
        raise bad_request(str(e))
    # Re-issue a session for this browser so the caller stays signed in.
    return _signed_in_response(request, principal.user_id)
