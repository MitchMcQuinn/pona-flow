"""Instance-admin endpoints: changelog vs GitHub main, Fly self-update."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, updates
from ..auth import Principal
from ..http_utils import bad_request, json_body, value_400_domain_500

log = logging.getLogger("pona_flow.routes.updates")

router = APIRouter()


def _upstream(exc: RuntimeError) -> HTTPException:
    log.warning("instance updates upstream: %s", exc)
    return HTTPException(status_code=502, detail=str(exc))


@router.get("/api/instance/updates")
def instance_updates(_p: Principal = Depends(auth.require_instance_admin)):
    try:
        return updates.status_payload()
    except ValueError as e:
        raise bad_request(str(e)) from e
    except RuntimeError as e:
        raise _upstream(e) from e


@router.post("/api/instance/updates/credentials")
async def instance_update_credentials(
    request: Request, _p: Principal = Depends(auth.require_instance_admin)
):
    body = await json_body(request)
    token = body.get("fly_api_token")
    app_name = body.get("fly_app_name")
    if token is not None and not isinstance(token, str):
        raise bad_request("fly_api_token must be a string")
    if app_name is not None and not isinstance(app_name, str):
        raise bad_request("fly_app_name must be a string")
    if token is None and app_name is None:
        raise bad_request("fly_api_token or fly_app_name is required")
    with value_400_domain_500():
        return updates.save_fly_credentials(token, app_name)


@router.post("/api/instance/updates/apply")
def instance_apply_update(_p: Principal = Depends(auth.require_instance_admin)):
    try:
        return updates.apply_update()
    except ValueError as e:
        raise bad_request(str(e)) from e
    except RuntimeError as e:
        raise _upstream(e) from e
