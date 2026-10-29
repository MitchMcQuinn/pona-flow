"""Run a console form's data or action sequence and shape the result for the UI.

The sequence runner stays ``sequence_service.run_sequence_once``. A finished run
returns ``inactive`` + ``final_result``. A human-in-the-loop pause returns
``pending`` with the ``state_id`` and the parameters the form should ask for
next. A wait or an error is still a failure.
"""

from __future__ import annotations

from typing import Any

from . import catalog, execution_run, sequence_service


class ConsoleRunError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def resolve_console_target(ref: str) -> dict[str, Any]:
    """The sequence or read operation a module named, by catalog id or by name."""
    token = (ref or "").strip()
    if not token:
        raise ConsoleRunError("sequenceId is required")
    direct = catalog.fetch_query_for_compose(token)
    query = direct if direct is not None else catalog.find_query_by_name(token)
    if query is None:
        raise ConsoleRunError("sequence was not found")
    return query


def execute_console_sequence(
    console: dict[str, Any],
    sequence_id: str,
    view_id: str,
    role: str,
    params: dict[str, Any] | None,
    principal_id: str | None,
    state_id: str | None = None,
) -> dict[str, Any]:
    sid = str(console.get("space_id") or "").strip()
    cid = str(console.get("id") or "").strip()
    seq = (sequence_id or "").strip()
    kind = (role or "").strip().lower()
    if kind not in ("data", "action"):
        raise ConsoleRunError("role must be data or action")
    run_params = dict(params or {})
    run_params.setdefault("console_id", cid)
    run_params.setdefault("view_id", (view_id or "").strip())
    query = resolve_console_target(seq)
    query_kind = str(query.get("kind") or "")
    if query_kind == "operation":
        operation = str(query.get("operation") or "")
        if kind == "data" and operation != "read":
            raise ConsoleRunError("data sequence must be a read")
        try:
            final_result = execution_run.run_catalog_read(sid, str(query.get("id") or ""), run_params)
        except PermissionError as exc:
            raise ConsoleRunError(str(exc), 403) from exc
        return {"status": "inactive", "final_result": final_result}
    if query_kind != "sequence":
        raise ConsoleRunError("sequence was not found")
    seq = str(query.get("id") or seq)
    resume = (state_id or "").strip()
    if resume:
        stored = catalog.fetch_state_package(resume)
        stored_seq = str(((stored or {}).get("package") or {}).get("sequence_query_id") or "").strip()
        if stored_seq and stored_seq != seq:
            raise ConsoleRunError("state does not belong to this sequence")
    result = sequence_service.run_sequence_once(
        sid,
        seq,
        run_params,
        state_id=resume or None,
        trigger="manual",
        principal_id=principal_id,
        audit_detail={
            "source": "console",
            "console_id": cid,
            "view_id": (view_id or "").strip(),
            "role": kind,
        },
    )
    status = str(result.get("status") or "")
    if status == "inactive":
        return {"status": "inactive", "final_result": result.get("final_result")}
    if status == "pending":
        return {
            "status": "pending",
            "state_id": str(result.get("state_id") or resume or ""),
            "step_id": str(result.get("step_id") or ""),
            "parameters": result.get("parameters") if isinstance(result.get("parameters"), list) else [],
        }

    message = str(result.get("message") or "").strip()
    if not message:
        if status == "waiting":
            message = "sequence is waiting"
        else:
            message = f"sequence returned {status or 'an unexpected status'}"
    code = 409 if status == "waiting" else 400
    raise ConsoleRunError(message, code)


_DATA_KEYS = ("dataSequenceId", "data_sequence_id", "sequenceId", "sequence_id")
_ACTION_KEYS = ("actionSequenceId", "action_sequence_id")


def _first_text(source: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _resolved_sequence_id(ref: str) -> str:
    """Catalog id for a sequence or operation name. Missing names stay blank."""
    token = (ref or "").strip()
    if not token:
        return ""
    try:
        query = resolve_console_target(token)
    except ConsoleRunError:
        return token
    kind = str(query.get("kind") or "")
    if kind == "sequence":
        return str(query.get("id") or "")
    if kind != "operation":
        return ""
    named = catalog.find_query_by_name(str(query.get("name") or ""))
    if named and str(named.get("kind") or "") == "sequence":
        return str(named.get("id") or "")
    return str(query.get("id") or "")


def _link_module(module: dict[str, Any]) -> dict[str, Any]:
    data_id = _resolved_sequence_id(_first_text(module, _DATA_KEYS))
    action_id = _resolved_sequence_id(_first_text(module, _ACTION_KEYS))
    module_type = str(module.get("type") or "")
    if not data_id and action_id and (module_type == "form" or module.get("dataSource") == "sequence"):
        data_id = action_id
    linked = dict(module)
    changed = False
    if data_id and linked.get("dataSequenceId") != data_id:
        linked["dataSequenceId"] = data_id
        changed = True
    if data_id and linked.get("dataSource") != "sequence":
        linked["dataSource"] = "sequence"
        changed = True
    if action_id and linked.get("actionSequenceId") != action_id:
        linked["actionSequenceId"] = action_id
        changed = True
    if action_id and linked.get("actionSource") != "sequence":
        linked["actionSource"] = "sequence"
        changed = True
    return linked if changed else module


def link_console_document(document: dict[str, Any] | None) -> dict[str, Any]:
    """Fill each module's data sequence from the id or name the agent stored, including a form's submit sequence."""
    if not isinstance(document, dict):
        return {}
    views = document.get("views")
    if not isinstance(views, list):
        return document
    next_views: list[Any] = []
    changed = False
    for view in views:
        if not isinstance(view, dict) or not isinstance(view.get("modules"), list):
            next_views.append(view)
            continue
        modules = []
        view_changed = False
        for module in view["modules"]:
            if not isinstance(module, dict):
                modules.append(module)
                continue
            linked = _link_module(module)
            if linked is not module:
                view_changed = True
            modules.append(linked)
        if view_changed:
            changed = True
            next_views.append({**view, "modules": modules})
        else:
            next_views.append(view)
    if not changed:
        return document
    return {**document, "views": next_views}
