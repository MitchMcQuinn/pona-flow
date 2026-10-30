"""One streamed agent turn: read and run immediately, queue writes into one batch."""

from __future__ import annotations

import json
from typing import Any, Iterator

from . import chat_models, chat_store, chat_tools
from .auth import Principal

_SYSTEM = """You are pona, the pona flow workbench agent currently logged in for space {space_id}.
You start with no catalog in context. Call read tools before you answer questions about what exists.
Do not call a read tool again once its result is in this conversation.
Reads and run_sequence execute immediately and use the signed-in user's permissions.
open_console, open_ephemeral_console, and open_builder put something on the user's canvas immediately.
propose_change does not write. Every propose_change in this turn becomes one batch the user accepts or rejects as a whole.
The proposal is a list. Each item expands into a read-only copy of that config (the create-an-event view, the step or sequence builder, the schema properties, or the console configuration). Put the real fields in the payload. A time event's schedule goes in event_package.groups as is_time "18:00" and is_weekday [1,2,3,4,5] (1 is Monday), plus timezone. The preview shows those fields. Saying "6pm weekdays" in a note does not fill the form. Put a one-sentence note on the item, and put field notes in pins, so those annotations sit inside the config.
Do not call open_console or open_ephemeral_console in a turn that proposes changes. A console that depends on those changes cannot run until the user accepts, so opening it first shows a console that does not work. Propose it with upsert_console. Open it only after the user has accepted, or when it already exists and does not depend on this batch.
show_walkthrough is for screens that already exist. Do not put an unsaved console in a walkthrough.
Create a SCHEMA with kind upsert_schema and payload attributive_label plus properties (each with key and value_type). Use only the kinds listed on propose_change.
Do not tell the user a write has landed until they accept it.
After you have looked, either propose the changes or answer the user. Do not stop after tools with nothing to say.
An upsert_query with kind operation is filed in the sequences list as a one-step sequence. Do not also create a separate sequence for that operation. Use kind sequence only for a chain whose cypher matches a STEP by attributive_label. That cypher must be one statement the visual builder can open: MATCH (var:INSTANCE|SCHEMA|STEP {{ attributive_label: 'name' }}), optional WHERE, then RETURN, SET, or DELETE (CREATE or MERGE to make a node). Hops are directed. Do not use WITH, UNION, CALL, or a custom label such as :Person — a name belongs in attributive_label.
Every console module must set dataSequenceId to a sequence or read operation, by catalog id or name. A form must also set actionSequenceId to the sequence that runs on submit, and dataSequenceId to the read that fills its inputs. Never leave dataSequenceId blank. A console document stores views as an array of {{id, name, kind, modules}}. A form module's fields go in config.fields. A text or stat module shows the scalar columns of a one-row result. A graph module shows the nodes and relationships that query returns. A table shows the rows. The example JSON for a module type is the shape, not data to put on the screen.
check_console_modules runs a module's data sequence and says what that module would show. For a button, switch, or form it names the sequence that runs on submit, and it does not execute that sequence. A module is correct only when the check says ok. ok is false when the module would show the expected-shape placeholder, when an action module would not run a sequence, or when the console has no modules. Call it before open_ephemeral_console when those sequences already exist. open_ephemeral_console refuses to open a console whose modules are not ok. If the sequences are created in the same proposal, the check waits until the user accepts. When a check is ok, tell the user only what that check reports for each module. If the check says the console has no modules, say that. Do not invent counts, rows, or names.
When a message says the user accepted a change batch and names a console to check, call check_console_modules for that console, then open_console. Say only what the check reports. If a module is not ok, or the console has no modules, say what is wrong and propose a fix. Do not call any other tool.
When a message says the user accepted a change batch and does not name a console to check, say what landed and ask one question or offer one next step. Do not call a tool in that reply.
Write replies, item notes, and pin notes in markdown. A pin note is inserted on the field it names.
Keep replies short. Put the useful view on the canvas instead of pasting large dumps into the chat.
"""

_FOLLOW_UP_MARK = "[[pona-follow-up]]"


def _model_text(content: str) -> str:
    """Drop the transcript marker so the model sees the follow-up instruction itself."""
    text = content or ""
    if text.startswith(_FOLLOW_UP_MARK):
        return text[len(_FOLLOW_UP_MARK) :].lstrip("\n")
    return text

def _stamp_insight(
    thread_id: str, item_id: str | None, payload: dict[str, Any], message_id: str
) -> None:
    """Tie a reasoning or read panel to the assistant message that produced it."""
    if not item_id:
        return
    stamped = dict(payload)
    stamped["message_id"] = message_id
    chat_store.update_stack_item(thread_id, item_id, payload=stamped)


def _is_read_tool(name: str) -> bool:
    return name.startswith(("list_", "get_", "describe_"))


_NUDGE = (
    "You have the tool results. Do not call another read tool. "
    "Reply to the user now. If the space should change, call propose_change."
)


def _history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recent transcript, without raw tool payloads from earlier turns."""
    trimmed = messages[-16:]
    body: list[dict[str, Any]] = []
    for message in trimmed:
        content = _model_text(message.get("content") or "")
        calls = message.get("tool_calls") or []
        if calls:
            names = ", ".join(str(call.get("name") or "") for call in calls if call.get("name"))
            if names:
                content = (content + f"\n(tools: {names})").strip()
        batch = message.get("batch")
        if isinstance(batch, dict):
            content = (
                content + f"\n(change batch {batch.get('status')}, {len(batch.get('items') or [])} items)"
            ).strip()
        body.append({"role": message.get("role") or "user", "content": content})
    return body


def _public_item(item: dict[str, Any]) -> dict[str, Any]:
    public: dict[str, Any] = {
        "kind": item.get("kind"),
        "summary": item.get("summary"),
        "payload": item.get("payload"),
        "preview": item.get("preview"),
    }
    note = str(item.get("note") or "").strip()
    if note:
        public["note"] = note
    pins = item.get("pins") if isinstance(item.get("pins"), list) else []
    if pins:
        public["pins"] = pins
    return public


def run_turn(
    *,
    space_id: str,
    principal: Principal,
    content: str,
    thread_id: str | None,
    model: tuple[dict[str, Any], str] | None = None,
    complete=None,
) -> Iterator[dict[str, Any]]:
    """Yield SSE-shaped events. Persists the thread even if the client disconnects."""
    text = (content or "").strip()
    if not text:
        raise ValueError("message is required")
    resolved = model if model is not None else chat_models.resolve_model(space_id)
    model_cfg, api_key = resolved
    runner = complete or chat_models.complete

    if thread_id:
        thread = chat_store.get_thread(thread_id, space_id, principal.user_id)
        if thread is None:
            raise ValueError("thread not found")
    else:
        title = "Next step" if text.startswith(_FOLLOW_UP_MARK) else _model_text(text)
        thread = chat_store.create_thread(space_id, principal.user_id, title)
    tid = thread["id"]
    chat_store.touch_thread(tid, None if text.startswith(_FOLLOW_UP_MARK) else text)
    chat_store.append_message(tid, "user", text)
    chat_store.set_turn_status(tid, "running")
    yield {"event": "start", "data": {"thread_id": tid, "title": thread.get("title") or text[:80]}}

    proposals: list[dict[str, Any]] = []
    tool_summaries: list[dict[str, Any]] = []
    reply = ""
    insight_ids: dict[str, str | None] = {"reasoning": None, "reads": None}
    reasoning_rounds: list[dict[str, Any]] = []
    reads: list[dict[str, Any]] = []
    try:
        prior = chat_store.get_thread(tid, space_id, principal.user_id) or thread
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": _SYSTEM.format(space_id=space_id)}
        ]
        messages.extend(_history(prior.get("messages") or []))

        def one_round() -> tuple[str, str, list[dict[str, Any]]]:
            round_text = ""
            round_thought = ""
            found: list[dict[str, Any]] = []
            for piece in runner(model_cfg, api_key, messages, chat_tools.TOOLS):
                if piece.get("type") == "text" and piece.get("delta"):
                    round_text += piece["delta"]
                    yield_text(piece["delta"])
                elif piece.get("type") == "thought" and piece.get("delta"):
                    round_thought += piece["delta"]
                elif piece.get("type") == "tool_call":
                    found.append(piece)
            return round_text, round_thought, found

        pending_text: list[str] = []

        def yield_text(delta: str) -> None:
            pending_text.append(delta)

        def take_text() -> Iterator[dict[str, Any]]:
            nonlocal reply
            for delta in pending_text:
                reply += delta
                yield {"event": "text", "data": {"delta": delta}}
            pending_text.clear()

        def run_calls(calls: list[dict[str, Any]], round_text: str) -> None:
            messages.append(
                {
                    "role": "assistant",
                    "content": round_text,
                    "tool_calls": [
                        {
                            "id": call.get("id"),
                            "name": call.get("name"),
                            "arguments": call.get("arguments") or {},
                            **(
                                {"thought_signature": call["thought_signature"]}
                                if call.get("thought_signature")
                                else {}
                            ),
                        }
                        for call in calls
                    ],
                }
            )
            for call in calls:
                name = str(call.get("name") or "")
                arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                yield_tool(name, arguments, call)

        tool_events: list[dict[str, Any]] = []
        max_rounds = chat_store.clamp_max_rounds(model_cfg.get("max_rounds"))

        def publish_insight(kind: str, title: str, payload: dict[str, Any]) -> None:
            current_id = insight_ids[kind]
            if current_id is None:
                item = chat_store.add_stack_item(tid, kind, title, payload, activate=False)
                insight_ids[kind] = item["id"]
                tool_events.append({"event": "canvas", "data": {"item": item}})
                return
            item = chat_store.update_stack_item(tid, current_id, payload=payload)
            if item is not None:
                tool_events.append({"event": "canvas_update", "data": {"item": item}})

        def publish_reads() -> None:
            publish_insight("reads", "Reads", {"entries": reads})

        def publish_reasoning() -> None:
            publish_insight("reasoning", "Reasoning", {"rounds": reasoning_rounds})

        deferred_canvases: list[dict[str, Any]] = []

        def publish_canvas(canvas: dict[str, Any]) -> None:
            item = chat_store.add_stack_item(
                tid,
                canvas["kind"],
                str(canvas.get("title") or canvas["kind"]),
                canvas.get("payload") if isinstance(canvas.get("payload"), dict) else {},
            )
            tool_events.append({"event": "canvas", "data": {"item": item}})

        def hold_until_proposal_settles(canvas: dict[str, Any]) -> None:
            """A console opened beside a pending proposal cannot run the changes it depends on."""
            deferred_canvases.append(canvas)

        def flush_deferred_canvases() -> None:
            for canvas in deferred_canvases:
                kind = canvas.get("kind")
                if proposals and kind in ("saved_console", "ephemeral_console"):
                    continue
                if proposals and kind == "walkthrough":
                    payload = canvas.get("payload") if isinstance(canvas.get("payload"), dict) else {}
                    frames = [
                        frame
                        for frame in payload.get("frames") or []
                        if isinstance(frame, dict) and frame.get("view") != "console"
                    ]
                    if not frames:
                        continue
                    canvas = {**canvas, "payload": {**payload, "frames": frames}}
                publish_canvas(canvas)
            deferred_canvases.clear()

        def yield_tool(name: str, arguments: dict[str, Any], call: dict[str, Any]) -> None:
            outcome = chat_tools.execute(name, arguments, principal, space_id, proposals)
            summary = name
            if outcome.proposal:
                summary = outcome.proposal.get("summary") or name
            elif outcome.canvases:
                summary = outcome.canvases[0].get("title") or name
            recorded: dict[str, Any] = {"name": name, "status": "done", "summary": summary}
            tool_event: dict[str, Any] = {
                "event": "tool",
                "data": {"name": name, "status": "done", "summary": summary},
            }
            if _is_read_tool(name):
                reads.append(
                    {
                        "name": name,
                        "arguments": arguments,
                        "result": chat_tools._clip(outcome.result),
                    }
                )
                recorded["read_index"] = len(reads) - 1
                tool_event["data"]["read_index"] = recorded["read_index"]
                publish_reads()
            tool_summaries.append(recorded)
            tool_events.append(tool_event)
            for canvas in outcome.canvases:
                if canvas.get("kind") in ("saved_console", "ephemeral_console", "walkthrough"):
                    hold_until_proposal_settles(canvas)
                    continue
                publish_canvas(canvas)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id") or name,
                    "name": name,
                    "content": json.dumps(outcome.result, default=str),
                }
            )

        def note_round(index: int, round_text: str, round_thought: str, calls: list[dict[str, Any]]) -> None:
            reasoning_rounds.append(
                {
                    "round": index,
                    "max": max_rounds,
                    "text": round_text,
                    "thought": round_thought,
                    "tools": [str(call.get("name") or "") for call in calls],
                }
            )
            publish_reasoning()

        for round_index in range(1, max_rounds + 1):
            yield {"event": "round", "data": {"index": round_index, "max": max_rounds}}
            round_text, round_thought, calls = one_round()
            yield from take_text()
            note_round(round_index, round_text, round_thought, calls)
            yield from tool_events
            tool_events.clear()
            if not calls:
                break
            run_calls(calls, round_text)
            yield from tool_events
            tool_events.clear()
        if not reply.strip():
            # A tool-only finish looks like a freeze: the tools are listed and then nothing.
            follow_up = text.startswith(_FOLLOW_UP_MARK)
            if follow_up and "check_console_modules" in text:
                nudge = (
                    "Call check_console_modules for the console in the message, then open_console. "
                    "Reply with only what the check reports. "
                    "If a module is not ok, or the console has no modules, say what is wrong."
                )
            elif follow_up:
                nudge = (
                    "The changes are already applied. Reply to the user now. "
                    "Say what landed, then ask one question or offer one next step. Do not call a tool."
                )
            else:
                nudge = _NUDGE
            messages.append({"role": "user", "content": nudge})
            round_text, round_thought, calls = one_round()
            yield from take_text()
            note_round(len(reasoning_rounds) + 1, round_text, round_thought, calls)
            yield from tool_events
            tool_events.clear()
            if calls:
                run_calls(calls, round_text)
                yield from tool_events
                tool_events.clear()
        if not reply.strip():
            reply = (
                "Those changes are in. What should we do next?"
                if text.startswith(_FOLLOW_UP_MARK)
                else "I stopped after those tool calls without a reply. Send another message and I will continue."
            )
            yield {"event": "text", "data": {"delta": reply}}
        flush_deferred_canvases()
        yield from tool_events
        tool_events.clear()
        batch = None
        if proposals:
            batch = {"status": "pending", "items": [_public_item(item) for item in proposals]}
            proposal = chat_store.add_stack_item(
                tid,
                "proposal",
                "Proposed changes",
                {"status": "pending", "items": batch["items"]},
            )
            yield {"event": "canvas", "data": {"item": proposal}}
        message = chat_store.append_message(tid, "assistant", reply, tool_summaries, batch)
        _stamp_insight(tid, insight_ids.get("reasoning"), {"rounds": reasoning_rounds}, message["id"])
        _stamp_insight(tid, insight_ids.get("reads"), {"entries": reads}, message["id"])
        if batch is not None:
            yield {
                "event": "batch",
                "data": {"message_id": message["id"], "batch": batch},
            }
        yield {"event": "done", "data": {"message_id": message["id"], "thread_id": tid}}
    except Exception as exc:
        error = str(exc)[:500]
        failed = chat_store.append_message(
            tid,
            "assistant",
            reply or error,
            tool_summaries,
            None,
        )
        _stamp_insight(tid, insight_ids.get("reasoning"), {"rounds": reasoning_rounds}, failed["id"])
        _stamp_insight(tid, insight_ids.get("reads"), {"entries": reads}, failed["id"])
        yield {"event": "error", "data": {"message": error}}
    finally:
        chat_store.set_turn_status(tid, "idle")
