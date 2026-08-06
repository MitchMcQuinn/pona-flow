"""
Authentication (Clerk JWT or agent API key) and authorization (RBAC) for the FastAPI app.

Purpose in the project
----------------------
This module is the security boundary the original ``http.server`` handler never had.
See ``Docs/DECISIONS.md`` (D3, D5, D8):

- **Authentication** is delegated to Clerk for humans. Clients send a Clerk session JWT
  as ``Authorization: Bearer <token>``. We verify it against Clerk's JWKS (signature +
  expiry), then map the Clerk user (``sub``) to a local ``users`` row. Agents (sequence
  webhooks, the MCP gateway) authenticate instead with a per-space ``stg_`` API key
  (see ``agent_keys.py``) resolved to an agent principal.
- **Authorization** is the hybrid RBAC layer in ``rbac.py``: space membership with
  per-space roles, flow permissions (``<operation>:<element>``), per-sequence run
  allowlists, and a ``manage_space`` capability. Space owners and the env-defined
  superadmin get full access; a separate instance-admin flag gates instance-wide
  operations and the raw catalog DB editor.

Bootstrap: the superadmin is defined by environment (SUPERADMIN_CLERK_ID / SUPERADMIN_EMAIL).

Exposed FastAPI dependencies
----------------------------
- ``current_principal`` — verifies the token, resolves/creates the local user, returns a
  ``Principal``. Use on every authenticated route.
- ``current_principal_or_agent`` — accepts an agent key OR a Clerk JWT (webhook routes).
- ``require_instance_admin`` — like above but 403s unless the user is an instance admin.

Helpers used inside route handlers (after ``space_id`` is known):
- ``require_space_access(principal, space_id)`` — 403 unless member/owner (admins pass).
- ``require_flow`` / ``require_sequence_run`` / ``require_space_manage`` /
  ``require_space_owner`` — RBAC guards over ``rbac.resolve_effective_permissions``.
- ``add_space_member`` / ``member_space_ids`` — manage and read membership.
"""

from __future__ import annotations

import hmac
import os
import sqlite3
import sys
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

try:  # PyJWT with crypto extra
    import jwt
    from jwt import PyJWKClient

    _JWT_AVAILABLE = True
except Exception:  # pragma: no cover - import guard
    _JWT_AVAILABLE = False

from . import agent_keys, clerk_api, config, id_generator, rbac


# ---------------------------------------------------------------------------
# Local-development auth bypass
# ---------------------------------------------------------------------------

# Fixed identity used for the synthetic principal when auth is disabled locally.
DEV_LOCAL_CLERK_ID = "dev-local-user"


def _auth_disabled() -> bool:
    """Whether Clerk auth is bypassed for local development (``PONA_FLOW_DISABLE_AUTH``).

    Read fresh from the environment on each call (no caching) so toggling it in ``.env``
    takes effect on the next request. Accepts ``1``/``true``/``yes``/``on`` (any case).
    The variable is never set in production, so the bypass is inert there.
    """
    raw = (os.environ.get("PONA_FLOW_DISABLE_AUTH") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _dev_local_principal() -> Principal:
    """A synthetic superadmin principal for local development when auth is disabled.

    Backed by a real ``users`` row (via :func:`get_or_create_user`) so spaces and other
    data created locally associate with a stable id across restarts. Elevated to
    superadmin so every RBAC-gated route is reachable without a Clerk session.
    """
    email = (os.environ.get("PONA_FLOW_DEV_USER_EMAIL") or "dev@localhost").strip() or "dev@localhost"
    base = get_or_create_user(DEV_LOCAL_CLERK_ID, email)
    return Principal(
        user_id=base.user_id,
        clerk_user_id=base.clerk_user_id,
        email=base.email,
        is_instance_admin=True,
        is_superadmin=True,
        can_create_spaces=True,
        principal_type=base.principal_type,
        timezone=base.timezone,
    )


# ---------------------------------------------------------------------------
# Clerk JWT verification
# ---------------------------------------------------------------------------

_jwk_client: "PyJWKClient | None" = None


def _clerk_jwks_url() -> str:
    """Resolve the Clerk JWKS URL from env (explicit URL or derived from issuer)."""
    url = (os.environ.get("CLERK_JWKS_URL") or "").strip()
    if url:
        return url
    issuer = (os.environ.get("CLERK_ISSUER") or "").strip().rstrip("/")
    if issuer:
        return f"{issuer}/.well-known/jwks.json"
    raise RuntimeError(
        "Clerk is not configured: set CLERK_JWKS_URL or CLERK_ISSUER in the environment."
    )


def _get_jwk_client() -> "PyJWKClient":
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(_clerk_jwks_url())
    return _jwk_client


def _authorized_parties() -> list[str]:
    raw = (os.environ.get("CLERK_AUTHORIZED_PARTIES") or "").strip()
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def _jwt_leeway_seconds() -> float:
    """Clock-skew tolerance for ``iat`` / ``exp`` checks (default 60s).

    Clerk tokens are minted on Clerk's clocks. If the host running this server is even
    slightly behind, PyJWT rejects fresh tokens as "not yet valid (iat)" and the UI's
    401 handler signs the user out immediately — a sign-in loop.
    """
    raw = (os.environ.get("CLERK_JWT_LEEWAY_SECONDS") or "60").strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 60.0


def verify_clerk_token(token: str) -> dict[str, Any]:
    """Verify a Clerk session JWT and return its claims, or raise HTTP 401."""
    if not _JWT_AVAILABLE:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="PyJWT is not installed; run pip install -r requirements.txt",
        )
    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
        issuer = (os.environ.get("CLERK_ISSUER") or "").strip().rstrip("/")
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer or None,
            leeway=_jwt_leeway_seconds(),
            options={"verify_aud": False, "require": ["exp", "sub"]},
        )
    except RuntimeError as e:
        # Misconfiguration (no JWKS URL/issuer): surface as 500, not 401.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )
    except Exception as e:
        # Log the specific failure server-side only; the client gets a generic message
        # so token internals (expiry, issuer, signature details) are not disclosed.
        print(f"clerk-token-verify-error: {e}", file=sys.stderr)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
        )

    parties = _authorized_parties()
    if parties:
        azp = str(claims.get("azp") or "")
        if azp and azp not in parties:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token authorized party is not allowed.",
            )
    return claims


# ---------------------------------------------------------------------------
# Local user resolution + membership (catalog data.db)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Principal:
    user_id: str
    clerk_user_id: str
    email: str | None
    is_instance_admin: bool
    # is_instance_admin mirrors is_superadmin (kept for existing callers / DB editor gate).
    is_superadmin: bool = False
    can_create_spaces: bool = False
    principal_type: str = "user"
    timezone: str | None = None


def _catalog_conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _is_superadmin(clerk_user_id: str, email: str | None) -> bool:
    """The single server superadmin is defined by env, not by signup order."""
    sa_clerk = config.superadmin_clerk_id()
    if sa_clerk and clerk_user_id and clerk_user_id == sa_clerk:
        return True
    sa_email = config.superadmin_email()
    if sa_email and email and email.strip().lower() == sa_email.strip().lower():
        return True
    return False


def get_or_create_user(clerk_user_id: str, email: str | None) -> Principal:
    """Resolve the local principal for a Clerk subject, creating it on first sight.

    The single superadmin is determined by environment (see :func:`_is_superadmin`),
    decoupled from signup order. On each sign-in, any pending email invites for this
    principal are claimed.
    """
    cid = (clerk_user_id or "").strip()
    if not cid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is missing a subject (sub) claim.",
        )
    conn = _catalog_conn()
    try:
        row = conn.execute(
            "SELECT id, clerk_user_id, email, display_name, can_create_spaces, "
            "       principal_type, timezone, is_instance_admin "
            "FROM users WHERE clerk_user_id = ?",
            (cid,),
        ).fetchone()
        if row is not None:
            user_id = row["id"]
            can_create = bool(row["can_create_spaces"])
            principal_type = row["principal_type"] or "user"
            timezone = row["timezone"]
            stored_email = row["email"]
            stored_name = row["display_name"]
            stored_admin = bool(row["is_instance_admin"])
        else:
            user_id = id_generator.generate_id()
            conn.execute(
                "INSERT INTO users (id, clerk_user_id, email, is_instance_admin) "
                "VALUES (?, ?, ?, ?)",
                (user_id, cid, email, 0),
            )
            conn.commit()
            can_create = False
            principal_type = "user"
            timezone = None
            stored_email = email
            stored_name = None
            stored_admin = False

        # Resolve a human identity from Clerk's Backend API when the token didn't carry
        # one. The email matters beyond display: pending invites are claimed by email.
        resolved_email = email or stored_email
        resolved_name = stored_name
        if not resolved_email or not resolved_name:
            identity = clerk_api.fetch_identity(cid)
            if identity:
                resolved_email = resolved_email or identity.get("email")
                resolved_name = resolved_name or identity.get("name")

        # Superadmin is env-derived. Session JWTs often omit email, so evaluate only after
        # the Clerk Backend API backfill above (see SUPERADMIN_EMAIL / SUPERADMIN_CLERK_ID).
        is_super = _is_superadmin(cid, resolved_email)

        # Persist any changes: email backfill, display name, and the env-derived
        # superadmin status (the source of truth) so admin listings stay accurate.
        updates: list[str] = []
        args: list[Any] = []
        if resolved_email and resolved_email != stored_email:
            updates.append("email = ?")
            args.append(resolved_email)
        if resolved_name and resolved_name != stored_name:
            updates.append("display_name = ?")
            args.append(resolved_name)
        if stored_admin != is_super:
            updates.append("is_instance_admin = ?")
            args.append(1 if is_super else 0)
        if updates:
            args.append(user_id)
            conn.execute(
                f"UPDATE users SET {', '.join(updates)}, "
                "modified_date = datetime('now') WHERE id = ?",
                args,
            )
            conn.commit()
        email = resolved_email
    finally:
        conn.close()

    # Claim pending invites addressed to this email (outside the connection above).
    if email:
        rbac.claim_pending_invites(user_id, email)

    return Principal(
        user_id=user_id,
        clerk_user_id=cid,
        email=email,
        is_instance_admin=is_super,
        is_superadmin=is_super,
        can_create_spaces=can_create or is_super,
        principal_type=principal_type,
        timezone=timezone,
    )


def add_space_member(
    space_id: str, user_id: str, is_owner: bool = False, role_id: str | None = None
) -> None:
    """Record an active membership (idempotent). Used when a principal creates a space."""
    rbac.add_member(space_id, user_id, is_owner=is_owner, role_id=role_id)


def member_space_ids(user_id: str) -> set[str]:
    """All space ids the principal is an active member of."""
    return rbac.member_space_ids(user_id)


def is_space_member(user_id: str, space_id: str) -> bool:
    return rbac.is_space_member(user_id, space_id)


# ---------------------------------------------------------------------------
# FastAPI dependencies + guards
# ---------------------------------------------------------------------------

_bearer = HTTPBearer(auto_error=True)


def _claim_email(claims: dict[str, Any]) -> str | None:
    """Extract a primary email from Clerk claims across common template keys.

    Clerk's default session token does not include an email; it appears only when the
    JWT template maps one (commonly to ``email``). We check a few well-known keys so a
    variety of templates work without further configuration.
    """
    for key in ("email", "email_address", "primary_email", "primary_email_address"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _principal_from_credentials(credentials: HTTPAuthorizationCredentials) -> Principal:
    """Verify a Clerk bearer token and resolve the local principal."""
    claims = verify_clerk_token(credentials.credentials)
    return get_or_create_user(str(claims.get("sub") or ""), _claim_email(claims))


async def current_principal(request: Request) -> Principal:
    """Verify the Clerk token and return the resolved local Principal.

    When ``PONA_FLOW_DISABLE_AUTH`` is set (local development only), skips Clerk entirely
    and returns a synthetic superadmin principal so no session token is required.
    """
    if _auth_disabled():
        return _dev_local_principal()
    credentials = await _bearer(request)
    return _principal_from_credentials(credentials)


# Header agents present instead of a Clerk bearer token. The ``stg_`` token is also
# accepted as an ``Authorization: Bearer <token>`` value for clients that can only set
# the standard header.
AGENT_KEY_HEADER = "X-Pona-Flow-Key"


def _agent_token_from_request(request: Request) -> str | None:
    """Extract an agent API token from the dedicated header or a Bearer authorization."""
    supplied = (request.headers.get(AGENT_KEY_HEADER) or "").strip()
    if supplied:
        return supplied
    authz = (request.headers.get("Authorization") or "").strip()
    if authz.lower().startswith("bearer "):
        candidate = authz[7:].strip()
        if candidate.startswith(agent_keys.KEY_PREFIX):
            return candidate
    return None


def _principal_from_agent_key(token: str) -> Principal | None:
    """Resolve a verified agent token into an agent ``Principal`` (or ``None``)."""
    info = agent_keys.verify_key(token)
    if not info:
        return None
    return Principal(
        user_id=str(info["principal_id"]),
        clerk_user_id="",
        email=None,
        is_instance_admin=False,
        is_superadmin=False,
        can_create_spaces=False,
        principal_type="agent",
    )


async def current_principal_or_agent(request: Request) -> Principal:
    """Authenticate either an agent API key OR a Clerk JWT.

    Agents (sequence webhooks, future MCP server) present an ``stg_`` token via the
    ``X-Pona-Flow-Key`` header or as a Bearer token; the resolved agent principal is
    authorized through the same space-membership/RBAC path as a human. Anything else
    falls back to the standard Clerk verification used by the UI.
    """
    token = _agent_token_from_request(request)
    if token:
        principal = _principal_from_agent_key(token)
        if principal is not None:
            return principal
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked agent key.",
        )
    return await current_principal(request)


def authenticate_request(request: Request) -> Principal | None:
    """Resolve a principal from a raw request, returning ``None`` on any failure.

    Unlike :func:`current_principal_or_agent` (a FastAPI dependency that raises HTTP
    errors), this is a plain helper for transports that operate below the FastAPI route
    layer — notably the MCP gateway's ASGI handler, which authenticates a request before
    delegating to the protocol session manager. It accepts the same credentials: an
    ``stg_`` agent key (``X-Pona-Flow-Key`` header or Bearer) or a Clerk session JWT.
    """
    token = _agent_token_from_request(request)
    if token:
        return _principal_from_agent_key(token)
    if _auth_disabled():
        return _dev_local_principal()
    authz = (request.headers.get("Authorization") or "").strip()
    if authz.lower().startswith("bearer "):
        candidate = authz[7:].strip()
        try:
            claims = verify_clerk_token(candidate)
        except HTTPException:
            return None
        return get_or_create_user(str(claims.get("sub") or ""), _claim_email(claims))
    return None


async def require_instance_admin(
    principal: Principal = Depends(current_principal),
) -> Principal:
    """Authenticated AND instance admin, else 403."""
    if not principal.is_instance_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Instance administrator privileges are required.",
        )
    return principal


# Header the static SQLite editor uses to present the local dev token.
DEV_DB_EDITOR_TOKEN_HEADER = "X-Dev-DB-Token"


def _dev_db_editor_token() -> str:
    """The local-only token that unlocks the raw DB editor without Clerk.

    Read fresh from the environment on each call (no caching) so toggling it in ``.env``
    takes effect on the next request. Empty/unset means the bypass is disabled.
    """
    return (os.environ.get("DEV_DB_EDITOR_TOKEN") or "").strip()


async def require_db_editor_admin(request: Request) -> Principal:
    """Gate for the raw catalog DB editor (``/api/db/*``).

    Production behaviour is identical to :func:`require_instance_admin`: a valid Clerk JWT
    belonging to an instance admin. As a **local-development convenience only**, if
    ``DEV_DB_EDITOR_TOKEN`` is set in the environment and the request presents a matching
    ``X-Dev-DB-Token`` header, access is granted as a synthetic admin without Clerk. The
    env var is never set in production, so the bypass is inert there.
    """
    if _auth_disabled():
        return _dev_local_principal()
    dev_token = _dev_db_editor_token()
    if dev_token:
        supplied = (request.headers.get(DEV_DB_EDITOR_TOKEN_HEADER) or "").strip()
        if supplied and hmac.compare_digest(supplied, dev_token):
            return Principal(
                user_id="dev-db-editor",
                clerk_user_id="dev-db-editor",
                email=None,
                is_instance_admin=True,
                is_superadmin=True,
                can_create_spaces=True,
            )
    # No (or wrong) dev token: fall back to the normal Clerk admin path.
    principal = await current_principal(request)
    return await require_instance_admin(principal)


def require_space_access(principal: Principal, space_id: str) -> None:
    """Raise 403 unless the principal may access the space.

    Instance admins may access any space. Otherwise the principal must be a member.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="space_id is required"
        )
    if principal.is_instance_admin:
        return
    if not is_space_member(principal.user_id, sid):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this space.",
        )


# ---------------------------------------------------------------------------
# RBAC guards (flows, sequence-run, space management, space creation)
# ---------------------------------------------------------------------------


def effective_permissions(principal: Principal, space_id: str) -> dict[str, Any]:
    """The principal's resolved permissions in a space (superadmin/owner -> all)."""
    return rbac.resolve_effective_permissions(
        principal.user_id, space_id, is_superadmin=principal.is_superadmin
    )


def require_flow(
    principal: Principal, space_id: str, operation: str, element: str
) -> None:
    """403 unless the principal may perform ``<operation>:<element>`` in the space."""
    require_space_access(principal, space_id)
    if principal.is_superadmin:
        return
    perms = effective_permissions(principal, space_id)
    if not rbac.perms_allow_flow(perms, operation, element):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You are not permitted to {operation} {element} in this space.",
        )


def require_sequence_run(
    principal: Principal, space_id: str, sequence_id: str
) -> None:
    """403 unless the principal may run the given sequence in the space."""
    require_space_access(principal, space_id)
    if principal.is_superadmin:
        return
    perms = effective_permissions(principal, space_id)
    if not rbac.perms_allow_sequence(perms, sequence_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not permitted to run this sequence.",
        )


def require_space_manage(principal: Principal, space_id: str) -> None:
    """403 unless the principal may manage the space (settings, events, members)."""
    require_space_access(principal, space_id)
    if principal.is_superadmin:
        return
    perms = effective_permissions(principal, space_id)
    if not rbac.perms_allow_manage(perms):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not permitted to manage this space.",
        )


def require_space_owner(principal: Principal, space_id: str) -> None:
    """403 unless the principal is an owner of the space (superadmin bypasses).

    Stronger than :func:`require_space_manage`: ownership changes (granting or revoking
    ``is_owner``) are reserved for existing owners so a non-owner manager cannot
    promote themselves or others to owner.
    """
    require_space_access(principal, space_id)
    if principal.is_superadmin:
        return
    if not rbac.is_space_owner(principal.user_id, (space_id or "").strip()):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a space owner may change ownership.",
        )


def require_can_create_spaces(principal: Principal) -> None:
    """403 unless the principal may create spaces (superadmin or granted capability)."""
    if principal.is_superadmin or principal.can_create_spaces:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You are not permitted to create spaces.",
    )
