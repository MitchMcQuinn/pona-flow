"""Generic catalog DB editor routes (instance admin, or local dev token).

Real ``PUT``/``DELETE`` exist for the catalog row editor; the
``X-HTTP-Method-Override`` hack is still honored on ``POST /api/db/rows`` for the
legacy static editor.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from .. import auth, catalog
from ..auth import Principal
from ..http_utils import bad_request, domain_500, json_body

router = APIRouter()


@router.get("/api/db/meta")
def db_meta(_p: Principal = Depends(auth.require_db_editor_admin)):
    with domain_500():
        return catalog.db_meta_payload()


@router.get("/api/db/rows")
def db_rows(
    table: str = Query(""),
    limit: int = Query(500),
    offset: int = Query(0),
    _p: Principal = Depends(auth.require_db_editor_admin),
):
    tbl = (table or "").strip()
    if not tbl:
        raise bad_request("Query parameter table is required")
    with domain_500():
        return catalog.db_fetch_rows(tbl, limit=limit, offset=offset)


def _db_insert(body: dict[str, Any]):
    table = (body.get("table") or "").strip()
    values = body.get("values")
    if not table:
        raise bad_request("table is required")
    if not isinstance(values, dict):
        raise bad_request("values must be an object")
    with domain_500():
        return catalog.db_insert_row(table, values)


def _db_update(body: dict[str, Any]):
    table = (body.get("table") or "").strip()
    pk = body.get("pk")
    values = body.get("values")
    if not table:
        raise bad_request("table is required")
    if not isinstance(pk, dict):
        raise bad_request("pk must be an object")
    if not isinstance(values, dict):
        raise bad_request("values must be an object")
    with domain_500():
        return catalog.db_update_row(table, pk, values)


def _db_delete(body: dict[str, Any]):
    table = (body.get("table") or "").strip()
    pk = body.get("pk")
    if not table:
        raise bad_request("table is required")
    if not isinstance(pk, dict):
        raise bad_request("pk must be an object")
    with domain_500():
        return catalog.db_delete_row(table, pk)


@router.post("/api/db/rows")
async def db_rows_post(
    request: Request, _p: Principal = Depends(auth.require_db_editor_admin)
):
    # Back-compat: the legacy static editor tunnels PUT/DELETE via this header.
    override = (request.headers.get("X-HTTP-Method-Override") or "").strip().upper()
    body = await json_body(request)
    if override == "PUT":
        return _db_update(body)
    if override == "DELETE":
        return _db_delete(body)
    return _db_insert(body)


@router.put("/api/db/rows")
async def db_rows_put(
    request: Request, _p: Principal = Depends(auth.require_db_editor_admin)
):
    return _db_update(await json_body(request))


@router.delete("/api/db/rows")
async def db_rows_delete(
    request: Request, _p: Principal = Depends(auth.require_db_editor_admin)
):
    return _db_delete(await json_body(request))
