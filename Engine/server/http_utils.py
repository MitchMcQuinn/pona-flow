"""
Shared HTTP helpers for the API route modules under ``server.routes``.

These capture the request-validation and error-mapping ritual that used to be repeated
inline in every handler of the monolithic ``app.py``:

- ``json_body`` — parse-a-JSON-object body with the original handler's semantics.
- ``require_body_space_id`` / ``require_query_space_id`` — the 30x "space_id is
  required" preamble.
- ``domain_500`` / ``value_400_domain_500`` — the standard exception -> status mapping
  (``DOMAIN_ERRORS`` -> 500, optionally ``ValueError`` -> 400 first).
- ``require_space`` / ``require_read`` / ``infer_node_label`` — space + RBAC-flow
  validation shared by the graph/schema read routes.
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager
from typing import Any

from fastapi import Request
from fastapi.exceptions import HTTPException

from . import auth, clerk_api, config, rbac
from .auth import Principal

# Exception types produced by the domain layer that map to a 500 with the message
# as the error body (the React client reads ``data.error``).
DOMAIN_ERRORS = (sqlite3.Error, OSError, KeyError, ValueError)


def bad_request(msg: str) -> HTTPException:
    return HTTPException(status_code=400, detail=msg)


async def json_body(request: Request) -> dict[str, Any]:
    """Parse a JSON object request body, mirroring the original handler semantics."""
    import json

    raw = await request.body()
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise bad_request(str(e))
    if not isinstance(data, dict):
        raise bad_request("JSON body must be an object")
    return data


@contextmanager
def domain_500():
    """Map ``DOMAIN_ERRORS`` raised by the wrapped domain call to an HTTP 500."""
    try:
        yield
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


@contextmanager
def value_400_domain_500():
    """Map ``ValueError`` to 400 (caller mistake) and other ``DOMAIN_ERRORS`` to 500."""
    try:
        yield
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))


def require_body_space_id(body: dict[str, Any], *, allow_id: bool = False) -> str:
    """The required ``space_id`` from a JSON body (optionally falling back to ``id``)."""
    space_id = str(body.get("space_id") or (body.get("id") if allow_id else "") or "").strip()
    if not space_id:
        raise bad_request("space_id is required")
    return space_id


def require_query_space_id(space_id: str | None) -> str:
    sid = (space_id or "").strip()
    if not sid:
        raise bad_request("Query parameter space_id is required")
    return sid


def require_path_space_id(space_id: str | None) -> str:
    sid = (space_id or "").strip()
    if not sid:
        raise bad_request("space_id is required")
    return sid


def require_space(principal: Principal, space_id: str | None) -> str:
    """Validate a query-param space_id and require space access. Returns the id."""
    sid = require_query_space_id(space_id)
    auth.require_space_access(principal, sid)
    return sid


def require_read(principal: Principal, space_id: str | None, element: str) -> str:
    """Validate space_id, then require the read flow for ``element``. Returns the id."""
    sid = require_query_space_id(space_id)
    auth.require_flow(principal, sid, "read", element)
    return sid


def node_label_in(value: str) -> str:
    nl = (value or "").strip().upper()
    return nl if nl in rbac.ELEMENTS else ""


def infer_node_label(body: dict[str, Any]) -> str:
    """Resolve the target element for a flow check from the request body.

    Prefers an explicit ``node_label``; otherwise infers from the first labeled
    Cypher pattern; defaults to STEP so a flow check is always applied.
    """
    nl = node_label_in(str(body.get("node_label") or ""))
    if nl:
        return nl
    for stmt in body.get("cypher") or []:
        m = re.search(r":(STEP|SCHEMA|INSTANCE)\b", str(stmt))
        if m:
            return m.group(1)
    return "STEP"


def is_valid_timezone(tz: str) -> bool:
    """True if ``tz`` is a resolvable IANA timezone name."""
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(tz)
        return True
    except Exception:
        return False


def enrich_principal_identities() -> None:
    """Best-effort backfill of member/principal emails+names from Clerk's Backend API.

    Called before serving the management lists so raw ids get resolved to human labels.
    No-op when Clerk is unconfigured; never raises (identity is non-critical to the read).
    """
    try:
        conn = config.connect_sqlite(config.catalog_sqlite_path())
        try:
            clerk_api.enrich_missing_identities(conn)
        finally:
            conn.close()
    except Exception:
        pass
