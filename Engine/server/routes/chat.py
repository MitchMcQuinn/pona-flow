"""Chat mode routes: threads, a streamed turn, batch accept/reject, and model settings."""

from __future__ import annotations

import json
import queue
import threading

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import StreamingResponse

from .. import auth, chat_agent, chat_apply, chat_models, chat_store, credentials
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
        model = chat_models.resolve_model(space_id)
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
                    model=model,
                ):
                    events.put(event)
            except Exception as exc:
                events.put({"event": "error", "data": {"message": str(exc)[:500]}})
            finally:
                events.put(None)

        threading.Thread(target=work, daemon=True).start()
        while True:
            item = events.get()
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
        if item.get("kind") == "proposal" and payload.get("status") == "pending":
            chat_store.update_stack_item(
                thread["id"],
                item["id"],
                payload={**payload, "status": status, "result": result},
            )
            break


@router.post("/api/spaces/{space_id}/chat/threads/{thread_id}/batch/accept")
def accept_batch(
    space_id: str, thread_id: str, principal: Principal = Depends(auth.current_principal)
):
    auth.require_space_access(principal, space_id)
    thread = _thread_or_404(thread_id, space_id, principal)
    pending = chat_store.pending_batch(thread)
    if pending is None:
        raise HTTPException(400, "no change is waiting")
    items = pending.get("items") if isinstance(pending.get("items"), list) else []
    result = chat_apply.apply_batch(principal, space_id, items)
    if result.get("validation_errors"):
        return result
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
    api_key = body.get("api_key")
    credential_name = str(body.get("credential_name") or "").strip()
    if isinstance(api_key, str) and api_key.strip():
        name = credential_name or "CHAT_MODEL"
        try:
            saved = credentials.upsert_credential(
                space_id,
                name,
                value=api_key.strip(),
                description="Chat mode model key",
            )
        except PermissionError as exc:
            raise HTTPException(400, str(exc))
        except ValueError as exc:
            raise bad_request(str(exc))
        body = {**body, "credential_name": saved["name"]}
        body.pop("api_key", None)
    else:
        body = {key: value for key, value in body.items() if key != "api_key"}
    try:
        cfg = chat_store.set_chat_model(space_id, body)
    except ValueError as exc:
        raise bad_request(str(exc))
    cfg["platform_configured"] = chat_models.platform_configured()
    return cfg
