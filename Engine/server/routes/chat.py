"""Chat mode routes: threads, a streamed turn, batch accept/reject, and model settings."""

from __future__ import annotations

import json
import queue
import threading

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import StreamingResponse

from .. import auth, chat_agent, chat_apply, chat_models, chat_plan, chat_store, chat_tools, credentials
from ..auth import Principal
from ..http_utils import bad_request, json_body

router = APIRouter()

_STACK_PAYLOAD_LIMIT = 256_000


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _thread_or_404(thread_id: str, space_id: str, principal: Principal) -> dict:
    thread = chat_store.get_thread(thread_id, space_id, principal.user_id)
    if thread is None:
        raise HTTPException(404, "thread not found")
    return thread


@router.get("/api/spaces/{space_id}/chat/threads")
def list_threads(space_id: str, principal: Principal = Depends(auth.current_principal)):
    auth.require_space_access(principal, space_id)
    return {"threads": chat_store.list_threads(space_id, principal.user_id)}


@router.get("/api/spaces/{space_id}/chat/threads/{thread_id}")
def read_thread(
    space_id: str, thread_id: str, principal: Principal = Depends(auth.current_principal)
):
    auth.require_space_access(principal, space_id)
    return _thread_or_404(thread_id, space_id, principal)


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/active")
async def set_active_stack(
    space_id: str,
    thread_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    body = await json_body(request)
    item_id = str(body.get("stack_item_id") or "").strip() or None
    if item_id and not any(item["id"] == item_id for item in thread["stack"]):
        raise bad_request("stack item was not found on this thread")
    chat_store.set_active_stack_item(thread["id"], item_id)
    return {"ok": True, "active_stack_item_id": item_id}


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/stack")
async def add_stack_item(
    space_id: str,
    thread_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    """The canvas records a follow-up (a resumed run, a new log) without another turn."""
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    body = await json_body(request)
    kind = str(body.get("kind") or "").strip()
    if kind not in chat_store.STACK_KINDS:
        raise bad_request("unknown canvas item kind")
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    if len(json.dumps(payload, default=str)) > _STACK_PAYLOAD_LIMIT:
        raise bad_request("canvas item is too large")
    item = chat_store.add_stack_item(
        thread["id"], kind, str(body.get("title") or kind), payload
    )
    return {"item": item}


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/stack/{item_id}")
async def update_stack_item(
    space_id: str,
    thread_id: str,
    item_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    body = await json_body(request)
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else None
    if payload is not None and len(json.dumps(payload, default=str)) > _STACK_PAYLOAD_LIMIT:
        raise bad_request("canvas item is too large")
    title = body.get("title")
    item = chat_store.update_stack_item(
        thread["id"],
        item_id,
        title=str(title) if isinstance(title, str) else None,
        payload=payload,
    )
    if item is None:
        raise HTTPException(404, "stack item not found")
    return {"item": item}


@router.post("/api/spaces/{space_id}/chat/context")
def prepare_session_context(space_id: str, principal: Principal = Depends(auth.current_principal)):
    """Start the reads a new chat session needs, so the first message can include them."""
    auth.require_space_access(principal, space_id)
    try:
        chat_tools.begin_session_reads(principal, space_id)
    except Exception as exc:
        raise HTTPException(500, str(exc)[:500]) from exc
    return {"ok": True}


@router.post("/api/spaces/{space_id}/chat/turns")
async def start_turn(
    space_id: str, request: Request, principal: Principal = Depends(auth.current_principal)
):
    auth.require_space_access(principal, space_id)
    body = await json_body(request)
    content = str(body.get("content") or "").strip()
    if not content:
        raise bad_request("message is required")
    thread_id = str(body.get("thread_id") or "").strip() or None
    if thread_id:
        thread = _thread_or_404(thread_id, space_id, principal)
        if thread.get("turn_status") == "running":
            raise HTTPException(409, "turn_running")
        if chat_store.pending_batch(thread):
            raise HTTPException(409, "batch_pending")
    try:
        models = {
            "planner": chat_models.resolve_model(space_id, "planner"),
            "surface": chat_models.resolve_model(space_id, "surface"),
            "builder": chat_models.resolve_model(space_id, "builder"),
        }
    except ValueError as exc:
        raise bad_request(str(exc))

    def generate():
        events: queue.Queue = queue.Queue()

        def work() -> None:
            try:
                for event in chat_agent.run_turn(
                    space_id=space_id,
                    principal=principal,
                    content=content,
                    thread_id=thread_id,
                    models=models,
                ):
                    events.put(event)
            except Exception as exc:
                events.put({"event": "error", "data": {"message": str(exc)[:500]}})
            finally:
                events.put(None)

        threading.Thread(target=work, daemon=True).start()
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                # A planning call can sit quiet while the model writes. A comment
                # keeps the browser stream open until the next real event.
                yield ": ping\n\n"
                continue
            if item is None:
                break
            yield _sse(item["event"], item["data"])

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _finish_batch(thread: dict, status: str, result: dict | None) -> None:
    pending = chat_store.pending_batch(thread)
    if pending is None:
        raise HTTPException(400, "no change is waiting")
    batch = {
        "status": status,
        "items": pending.get("items") or [],
        "result": result,
    }
    chat_store.update_message_batch(pending["message_id"], batch)
    for item in reversed(thread.get("stack") or []):
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        kind = item.get("kind")
        if kind == "proposal" and payload.get("status") == "pending":
            chat_store.update_stack_item(
                thread["id"],
                item["id"],
                payload={**payload, "status": status, "result": result},
            )
            break
        if kind == "plan" and payload.get("batch_status") == "pending":
            chat_store.update_stack_item(
                thread["id"],
                item["id"],
                payload={**payload, "batch_status": status, "result": result},
            )
            break


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/batch/accept")
async def accept_batch(
    space_id: str,
    thread_id: str,
    request: Request,
    principal: Principal = Depends(auth.current_principal),
):
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    pending = chat_store.pending_batch(thread)
    if pending is None:
        raise HTTPException(400, "no change is waiting")
    body = await json_body(request)
    phase = str(body.get("phase") or "complete").strip() or "complete"
    if phase not in ("settings", "rest", "complete"):
        raise bad_request("phase must be settings, rest, or complete")
    secrets = body.get("credential_secrets")
    if secrets is not None and not isinstance(secrets, dict):
        raise bad_request("credential_secrets must be an object")
    applied = body.get("authoring_applied")
    if applied is not None and not isinstance(applied, list):
        raise bad_request("authoring_applied must be an array")
    failed = body.get("authoring_failed")
    if failed is not None and not isinstance(failed, dict):
        raise bad_request("authoring_failed must be an object")
    items = pending.get("items") if isinstance(pending.get("items"), list) else []
    result = chat_apply.apply_batch(
        principal,
        space_id,
        items,
        phase=phase,
        authoring_applied=applied if isinstance(applied, list) else None,
        authoring_failed=failed if isinstance(failed, dict) else None,
        credential_secrets={str(key): str(value) for key, value in secrets.items()}
        if isinstance(secrets, dict)
        else None,
    )
    if result.get("validation_errors"):
        return result
    if result.get("finished", True):
        status = "accepted" if result.get("ok") else "partial"
        _finish_batch(thread, status, result)
    return result


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/batch/reject")
def reject_batch(
    space_id: str, thread_id: str, principal: Principal = Depends(auth.current_principal)
):
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    _finish_batch(thread, "rejected", None)
    return {"ok": True, "status": "rejected"}


def _open_plan(thread: dict) -> dict | None:
    for item in reversed(thread.get("stack") or []):
        if item.get("kind") != "plan":
            continue
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if payload.get("status") == "confirmed":
            continue
        return item
    return None


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/plan/confirm")
def confirm_plan(
    space_id: str, thread_id: str, principal: Principal = Depends(auth.current_principal)
):
    """Compile a ready brief into a proposal. The planner is not called."""
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    if chat_store.pending_batch(thread):
        raise HTTPException(409, "batch_pending")
    plan = _open_plan(thread)
    if plan is None:
        raise HTTPException(400, "no plan is waiting")
    payload = plan.get("payload") if isinstance(plan.get("payload"), dict) else {}
    brief = payload.get("brief") if isinstance(payload.get("brief"), dict) else {}
    try:
        fitted = chat_plan.preview_for_brief(space_id, brief)
    except ValueError as exc:
        problem = str(exc)
        chat_store.update_stack_item(
            thread["id"],
            plan["id"],
            payload={
                **payload,
                "brief": brief,
                "blocking": [problem],
                "ready": False,
                "status": "consulting",
                "preview": {"items": [], "error": problem, "problems": []},
            },
        )
        return {"ok": False, "blocking": [problem]}
    brief = fitted["brief"]
    items = fitted["items"]
    blocking = chat_plan.readiness(brief)
    public = [_public_batch_item(item) for item in items]
    if not items and not blocking:
        blocking = [chat_plan.ALREADY_CONFIGURED]
    if blocking:
        chat_store.update_stack_item(
            thread["id"],
            plan["id"],
            payload={
                **payload,
                "brief": brief,
                "blocking": blocking,
                "ready": False,
                "status": "consulting",
                "preview": {
                    "items": public,
                    "problems": [],
                    "already": fitted["already"],
                    "conflicts": fitted["conflicts"],
                    "configured": fitted["configured"],
                },
            },
        )
        return {"ok": False, "blocking": blocking}
    problems = chat_plan.validation_problems(principal, space_id, items)
    if problems:
        questions = list(brief.get("open_questions") or [])
        for problem in problems:
            if not any(question.get("question") == problem for question in questions if isinstance(question, dict)):
                questions.append({"id": problem[:80], "question": problem, "blocks": "compile"})
        revised = {**brief, "open_questions": questions, "status": "consulting"}
        chat_store.update_stack_item(
            thread["id"],
            plan["id"],
            payload={
                "status": "consulting",
                "brief": revised,
                "blocking": problems,
                "ready": False,
                "preview": {"items": public, "problems": problems},
            },
        )
        return {"ok": False, "blocking": problems}
    named_inputs = chat_apply.collect_inputs(items)
    batch: dict = {"status": "pending", "items": public}
    confirmed = {**brief, "status": "confirmed"}
    confirmed_payload: dict = {
        "status": "confirmed",
        "brief": confirmed,
        "blocking": [],
        "ready": False,
        "items": public,
        "batch_status": "pending",
        "preview": {"items": public, "problems": [], "already": fitted["already"]},
    }
    if named_inputs:
        confirmed_payload["inputs"] = named_inputs
        batch["inputs"] = named_inputs
    proposal = chat_store.update_stack_item(thread["id"], plan["id"], payload=confirmed_payload)
    assumptions = [
        str(item.get("adds") or "")
        for item in confirmed.get("assumptions") or []
        if isinstance(item, dict) and item.get("adds")
    ]
    summary = "The plan is ready to accept."
    if assumptions:
        summary = "Assumed: " + " ".join(assumptions)
    message = chat_store.append_message(thread["id"], "assistant", summary, [], batch)
    return {
        "ok": True,
        "blocking": [],
        "summary": summary,
        "message_id": message["id"],
        "proposal": proposal,
    }


def _public_batch_item(item: dict) -> dict:
    public = {
        "kind": item.get("kind"),
        "summary": item.get("summary"),
        "payload": item.get("payload"),
        "preview": item.get("preview"),
    }
    if item.get("note"):
        public["note"] = item["note"]
    if item.get("pins"):
        public["pins"] = item["pins"]
    if item.get("inputs"):
        public["inputs"] = item["inputs"]
    return public


@router.get("/api/spaces/{space_id}/chat-model")
def read_chat_model(space_id: str, principal: Principal = Depends(auth.current_principal)):
    auth.require_space_access(principal, space_id)
    cfg = chat_store.get_chat_model(space_id)
    cfg["platform_configured"] = chat_models.platform_configured()
    return cfg


@router.post("/api/spaces/{space_id}/chat-model")
async def write_chat_model(
    space_id: str, request: Request, principal: Principal = Depends(auth.current_principal)
):
    auth.require_space_manage(principal, space_id)
    body = await json_body(request)

    def store_key(secret: object, holder: dict, default_name: str) -> dict:
        if not isinstance(secret, str) or not secret.strip():
            return holder
        name = str(holder.get("credential_name") or "").strip() or default_name
        try:
            saved = credentials.upsert_credential(
                space_id,
                name,
                value=secret.strip(),
                description="Chat mode model key",
            )
        except PermissionError as exc:
            raise HTTPException(400, str(exc))
        except ValueError as exc:
            raise bad_request(str(exc))
        return {**holder, "credential_name": saved["name"]}

    if isinstance(body.get("planner"), dict):
        body["planner"] = store_key(body.get("planner_api_key") or body.get("api_key"), body["planner"], "CHAT_MODEL")
    elif isinstance(body.get("api_key"), str) and body.get("api_key").strip():
        body = store_key(body.get("api_key"), body, "CHAT_MODEL")
    if isinstance(body.get("surface"), dict):
        body["surface"] = store_key(body.get("surface_api_key"), body["surface"], "CHAT_MODEL_SURFACE")
    if isinstance(body.get("builder"), dict):
        body["builder"] = store_key(body.get("builder_api_key"), body["builder"], "CHAT_MODEL_BUILDER")
    body = {
        key: value
        for key, value in body.items()
        if key not in ("api_key", "planner_api_key", "surface_api_key", "builder_api_key")
    }
    try:
        cfg = chat_store.set_chat_model(space_id, body)
    except ValueError as exc:
        raise bad_request(str(exc))
    cfg["platform_configured"] = chat_models.platform_configured()
    return cfg
