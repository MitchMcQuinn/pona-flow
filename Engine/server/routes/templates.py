"""Space template routes (space managers).

Export a space (selectable SQLite tables + graph patterns) to a portable JSON file,
and import such a file with conflict-aware name remapping. Import is idempotent and
resumable: the resolved plan is persisted under the template id and every statement is
a MERGE/upsert, so an interrupted run can be re-applied.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, templates
from ..auth import Principal
from ..http_utils import (
    DOMAIN_ERRORS,
    bad_request,
    json_body,
    require_path_space_id,
)

router = APIRouter()


@router.post("/api/spaces/{space_id}/templates/export")
async def templates_export(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Resolve a selection's dependency closure and build the template JSON.

    The body carries ``{"selection": {sequences, operations, schemas, instances,
    events}}``; the UI calls this as its "resolve then download" step and renders the
    returned ``summary`` before saving the document.
    """
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    selection = body.get("selection") if isinstance(body.get("selection"), dict) else body
    try:
        return templates.build_export(sid, selection)
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/api/spaces/{space_id}/templates/import/preview")
async def templates_import_preview(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Report the name collisions an operator must resolve before applying a template."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    template = body.get("template")
    if not isinstance(template, dict):
        raise bad_request("template is required")
    try:
        return templates.preview_import(sid, template)
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/api/spaces/{space_id}/templates/import/apply")
async def templates_import_apply(
    space_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """Validate then idempotently apply a template (resuming an interrupted run)."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    body = await json_body(request)
    template = body.get("template")
    if not isinstance(template, dict):
        raise bad_request("template is required")
    remaps = body.get("remaps") if isinstance(body.get("remaps"), list) else []
    try:
        return templates.apply_import(sid, template, remaps)
    except ValueError as e:
        raise bad_request(str(e))
    except DOMAIN_ERRORS as e:
        raise HTTPException(500, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.get("/api/spaces/{space_id}/templates/import/{template_id}")
def templates_import_status(
    space_id: str,
    template_id: str,
    principal: Principal = Depends(auth.current_principal),
):
    """Return persisted progress for an import so the UI can offer to resume it."""
    sid = require_path_space_id(space_id)
    auth.require_space_manage(principal, sid)
    status = templates.get_import_status(sid, template_id)
    if status is None:
        raise HTTPException(404, "template import not found")
    return status
