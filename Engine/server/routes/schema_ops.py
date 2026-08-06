"""SCHEMA update (apply/preview) and the SCHEMA / STEP delete cascade routes.

The two delete flows share one parameterized handler pair: they differ only in the
RBAC element gated on and the domain functions called.
"""

from __future__ import annotations

import sys
from typing import Any, Callable

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException

from .. import auth, schema_delete, schema_workflow, step_delete
from ..auth import Principal
from ..http_utils import DOMAIN_ERRORS, bad_request, json_body, require_body_space_id

router = APIRouter()


def _schema_update_args(body: dict[str, Any]) -> tuple[str, str, str, list[Any]]:
    """Validate and unpack the shared apply/preview request body."""
    space_id = require_body_space_id(body)
    schema_id = str(body.get("schema_id") or "").strip()
    attributive_label = str(body.get("attributive_label") or "").strip()
    schemata = body.get("schemata")
    if not schema_id:
        raise bad_request("schema_id is required")
    if not isinstance(schemata, list):
        raise bad_request("schemata must be an array")
    return space_id, schema_id, attributive_label, schemata


@router.post("/api/schema/update")
async def schema_update_apply(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    body = await json_body(request)
    space_id, schema_id, attributive_label, schemata = _schema_update_args(body)
    auth.require_flow(principal, space_id, "update", "SCHEMA")
    try:
        return schema_workflow.apply_schema_update(
            space_id, schema_id, attributive_label, schemata
        )
    except ValueError as e:
        raise bad_request(str(e))
    except Exception as e:
        sys.stderr.write(f"schema-update error: {e}\n")
        raise HTTPException(500, str(e))


@router.post("/api/schema/update/preview")
async def schema_update_preview(
    request: Request, principal: Principal = Depends(auth.current_principal)
):
    """Dry run for a SCHEMA update: validate the (add/delete-only) diff and report which
    sequences *would* be suspended, without persisting anything. Drives the confirmation
    modal so the user can abort before any change is committed."""
    body = await json_body(request)
    space_id, schema_id, attributive_label, schemata = _schema_update_args(body)
    auth.require_flow(principal, space_id, "update", "SCHEMA")
    try:
        return schema_workflow.preview_schema_update(
            space_id, schema_id, attributive_label, schemata
        )
    except ValueError as e:
        raise bad_request(str(e))
    except Exception as e:
        sys.stderr.write(f"schema-update-preview error: {e}\n")
        raise HTTPException(500, str(e))


def _register_delete_routes(
    *,
    path_prefix: str,
    element: str,
    kind: str,
    preview_fn: Callable[[str, str], dict[str, Any]],
    execute_fn: Callable[..., dict[str, Any]],
) -> None:
    """Register the preview/execute delete-cascade route pair for SCHEMA or STEP.

    The two flows are structurally identical: validate space_id + attributive_label,
    gate on the delete flow for ``element``, then call the domain preview/execute.
    """

    async def _delete_args(
        request: Request, principal: Principal, *, require_confirm: bool
    ) -> tuple[str, str]:
        body = await json_body(request)
        space_id = require_body_space_id(body)
        attributive_label = str(body.get("attributive_label") or "").strip()
        if not attributive_label:
            raise bad_request("attributive_label is required")
        if require_confirm and not bool(body.get("confirm") or False):
            raise bad_request(f"confirm must be true to execute a {kind} deletion")
        auth.require_flow(principal, space_id, "delete", element)
        return space_id, attributive_label

    @router.post(f"{path_prefix}/preview", name=f"{kind}_delete_preview")
    async def delete_preview(
        request: Request, principal: Principal = Depends(auth.current_principal)
    ):
        space_id, attributive_label = await _delete_args(
            request, principal, require_confirm=False
        )
        try:
            return preview_fn(space_id, attributive_label)
        except ValueError as e:
            raise bad_request(str(e))
        except DOMAIN_ERRORS as e:
            raise HTTPException(500, str(e))
        except Exception as e:
            sys.stderr.write(f"{kind}-delete-preview error: {e}\n")
            raise HTTPException(500, str(e))

    @router.post(path_prefix, name=f"{kind}_delete_execute")
    async def delete_execute(
        request: Request, principal: Principal = Depends(auth.current_principal)
    ):
        space_id, attributive_label = await _delete_args(
            request, principal, require_confirm=True
        )
        try:
            return execute_fn(space_id, attributive_label, confirm=True)
        except ValueError as e:
            raise bad_request(str(e))
        except DOMAIN_ERRORS as e:
            raise HTTPException(500, str(e))
        except Exception as e:
            sys.stderr.write(f"{kind}-delete error: {e}\n")
            raise HTTPException(500, str(e))


_register_delete_routes(
    path_prefix="/api/schema/delete",
    element="SCHEMA",
    kind="schema",
    preview_fn=schema_delete.preview_schema_deletion,
    execute_fn=schema_delete.execute_schema_deletion,
)
_register_delete_routes(
    path_prefix="/api/step/delete",
    element="STEP",
    kind="step",
    preview_fn=step_delete.preview_step_deletion,
    execute_fn=step_delete.execute_step_deletion,
)
