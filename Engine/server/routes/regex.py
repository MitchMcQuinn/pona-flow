"""Regex validation-pattern routes (any authenticated principal).

The builder's string-format dropdown needs these; they are instance-global,
non-sensitive reference data, so they must not require the instance-admin
``/api/db/*`` editor gate (which 403'd regex loading for normal users).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import auth, catalog
from ..auth import Principal
from ..http_utils import bad_request, domain_500, json_body, value_400_domain_500

router = APIRouter()


@router.get("/api/regex")
def regex_patterns(_p: Principal = Depends(auth.current_principal)):
    with domain_500():
        return {"patterns": catalog.list_regex_patterns()}


@router.post("/api/regex")
async def regex_patterns_add(
    request: Request, _p: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    name = str(body.get("name") or "").strip()
    regex = body.get("regex")
    if not name:
        raise bad_request("name is required")
    if regex is not None and not isinstance(regex, str):
        raise bad_request("regex must be a string")
    with value_400_domain_500():
        return catalog.add_regex_pattern(name, regex or "")
