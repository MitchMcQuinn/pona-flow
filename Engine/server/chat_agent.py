"""One streamed agent turn: read and run immediately, queue writes into one batch."""

from __future__ import annotations

import json
from typing import Any, Iterator

from . import chat_apply, chat_models, chat_plan, chat_store, chat_tools
from .auth import Principal

_CATALOG_NOTE = (
    "You start with no catalog in context. Call read tools before you answer questions about what exists. "
    "Do not call a read tool again once its result is in this conversation."
)

_SNAPSHOT_NOTE = (
    "A session snapshot of describe_space, describe_settings, list_schemas, list_steps, list_catalog, "
    "list_consoles, and list_events is already in the user message. Do not call those tools again. "
    "Call a narrower read when you need one record. "
    "Do not call a read tool again once its result is in this conversation."
)

_SYSTEM = """You are pona, the pona flow workbench agent currently logged in for space {space_id}.
{catalog_note}
Reads and run_sequence execute immediately and use the signed-in user's permissions.
open_console, open_ephemeral_console, and open_builder put something on the user's canvas immediately.
Before a plan that creates data, a console, or an event, use describe_settings. Call it when that result is not already in the conversation.
Do not tell the user a write has landed until they accept it.
Write replies in markdown.
Keep replies short. Put the useful view on the canvas instead of pasting large dumps into the chat.
"""

_BUILDER = """
You file changes for this space. Call propose_change for anything that should be saved. Do not call update_plan.
propose_change does not write. Every propose_change in this turn becomes one batch the user accepts or rejects as a whole. When propose_change returns errors, each error names a field and the requirement it failed. Change that field and call propose_change again. Do not tell the user the change is ready while a field error is unresolved.
The proposal is a list. Each item expands into a read-only copy of that config (the create-an-event view, the step or sequence builder, the schema properties, or the console configuration). Put the real fields in the payload. A time event's schedule goes in event_package.groups as is_time "18:00" and is_weekday [1,2,3,4,5] (1 is Monday), plus timezone. The preview shows those fields. Saying "6pm weekdays" in a note does not fill the form. Put a one-sentence note on the item, and put field notes in pins, so those annotations sit inside the config.
Do not call open_console or open_ephemeral_console in a turn that proposes changes. A console that depends on those changes cannot run until the user accepts, so opening it first shows a console that does not work. Propose it with upsert_console. Open it only after the user has accepted, or when it already exists and does not depend on this batch.
show_walkthrough is for screens that already exist. Do not put an unsaved console in a walkthrough.
Create a SCHEMA with kind upsert_schema and payload attributive_label plus properties (each with key and value_type). Exactly one property has is_label true and is_required true; that value is the instance's display name. Put it on the name-like field. Use only the kinds listed on propose_change. Do not send cypher, sqlite, builder_config, or a raw query object. Describe the same fields a person fills in on that screen. A SCHEMA attributive_label belongs to that schema alone. Do not reuse it as a STEP attributive_label, a sequence entry_step, or an operation name. The saved schema operation is wrapped in a STEP named create_<label>.
Builder order in one batch: upsert_schema, then upsert_query kind operation for each step, then create_transition for each link, then upsert_query kind sequence with entry_step, then the event or console. An operation is filed as a one-step sequence. Do not also propose a sequence for that same step. Use kind sequence only for a chain. Pass id only when updating something that already exists.
Include a settings item in the same batch when the plan needs it: update_embeddings and a later reindex_embeddings for a vectorized schema, upsert_credential before a chat model or HTTP step that names one, update_role before invite_member when the role does not exist, update_space dev_mode only when the user asked to see Cypher. Do not send secrets. Name a credential that already exists, or propose upsert_credential and let the user type the secret. Call open_settings when the user should look at a tab. Do not propose reset, factory reset, logout, or an instance update.
A console a person opens has no trigger_kind. Set trigger_kind to event only together with trigger_event_id for a time or external event. A simulated event cannot trigger a console. Every console module must set dataSequenceId to a sequence or read operation, by catalog id or name. A form must also set actionSequenceId to the sequence that runs on submit, and dataSequenceId to the read that fills its inputs. Never leave dataSequenceId blank. A console document stores views as an array of {{id, name, kind, modules}}. A form module's fields go in config.fields. A text or stat module shows the scalar columns of a one-row result. A graph module shows the nodes and relationships that query returns. A table shows the rows. The example JSON for a module type is the shape, not data to put on the screen.
When a proposal creates an event, seeds rows, or a console someone uses to enter or refresh data, name each input on one propose_change call. inputs is an array of {{name, source, lands_as}}. source is person, clock, external, simulated, or seed. lands_as is console, time_event, external_event, simulated_event, or execute_package. A person uses a console. A real clock is a time event. An outside system they have is an external event. An outside system they are only describing is a simulated event or a console control. Rows you invent so a view is not empty are seed, written by an upsert_query create INSTANCE operation with execute true. A create INSTANCE writes one row: set its key property to a literal value or a $parameter. UNWIND is only for a read, and a property cannot be row.field. Seed several rows with one executed create per row. If they did not name a live source, model it. Do not enable a time or external event for a source they do not have. The proposal is shown either way. Say what is unmatched. Do not propose the same items again to fix inputs.
check_console_modules runs a module's data sequence and says what that module would show. For a button, switch, or form it names the sequence that runs on submit, and it does not execute that sequence. A module is correct only when the check says ok. ok is false when the module would show the expected-shape placeholder, when an action module would not run a sequence, or when the console has no modules. Call it before open_ephemeral_console when those sequences already exist. open_ephemeral_console refuses to open a console whose modules are not ok. If the sequences are created in the same proposal, the check waits until the user accepts. When a check is ok, tell the user only what that check reports for each module. If the check says the console has no modules, say that. Do not invent counts, rows, or names.
When a message says the user accepted a change batch and names a console to check, call check_console_modules for that console, then open_console. Say only what the check reports. If a module is not ok, or the console has no modules, say what is wrong and propose a fix. Do not call any other tool.
When a message says the user accepted a change batch and does not name a console to check, say what landed and ask one question or offer one next step. Do not call a tool in that reply.
When that message lists inputs, say which are simulated or set from the console, and which one to switch to a live event when the real source exists.
Write replies, item notes, and pin notes in markdown. A pin note is inserted on the field it names.
"""

_FOLLOW_UP_MARK = "[[pona-follow-up]]"

_ROUTE = """
Your first tool call is choose_route.
deep: the user is describing or changing the system, a record kind, an operation, a screen, or a decision. Choosing or changing any of those is deep, even when they are answering a question. Answering the open question is deep, including when they say they do not know.
surface: the user is confirming a source, describing a simulation, dropping an assumption, or asking what exists.
"""

_PLANNER = """
You are shaping the plan brief. Call update_plan with the sections you can fill.
When a plan is already open, revise that brief from the user's latest message. Send only the sections that change so the rest stays. Replace the routine when they chose a different system.
The user's latest message answers the open question. Write that answer into the brief and remove the question. If they say they do not know, adopt the example already named in the question, record it as an assumption, and remove the question. Do not send the same question back. If the open question asks what they are looking to add, revise the brief with that addition and remove the question. If it says a name is already in this space, replace that name with their answer and remove the question.
routine is the routine work this system is built around. Pona flow builds systems for routine work, and this field keeps that in view for you. Write it from what the user asked for. Managing and publishing a blog is the routine. Do not ask them what the routine is, and do not ask them to narrow it to one decision. A routine often contains several decisions. Do not put a question about the routine in open_questions.
ontology is yours to design. Choose the record kinds, the property that names each one, the other properties the routine needs, and the links between kinds. A record kind is created once as a schema. Schema creation is not a sequence the user runs. A path, an operation, and a screen may name only those kinds. When you add an operation or a screen for a kind, add that kind in the same update. Do not ask the user which types to register, and do not ask them to confirm the link structure. Do not put that question in open_questions.
operations are the instance actions each kind needs. Each entry is {type, operation} and operation is list, read, create, update, or delete. A content system needs these. create is saved as add_<type>, because create_<type> is the one-time schema step.
screens are the consoles a person uses. Each screen has a name and views. A view is {name, module, subject, data, action}. module is table, form, graph, stat, text, number, or button. A table uses data list. A form uses data read and action create or update. A graph shows a link from the subject. A number module is only a numeric input to a decision. data and action are list, read, create, update, or delete.
outputs are the decisions, one sequence each. When a decision has two results, put them in results. A sequence chains steps only when one step's result feeds the next. Leave outputs empty when the system is record operations and screens.
multi_hop.needed is true only when a decision's fact is on a related record, and path is those kinds in order. A link on its own is not a decision.
reconstruction says which link a decision loads, and avoids_runtime_guess is true only when a decision reads that link. Leave it empty when the system is screens and record operations.
inputs use source person, clock, external, simulated, or seed. A person uses a screen. A clock or a live external system stays unconfirmed until the user says they have it. A system they are only describing is simulated, with a tic unit and one situation per distinct outcome.
vector.used is true only to name the subject of a decision in other words. The hop read follows it.
When the system message lists schemas and steps already in this space, those names exist. The session snapshot lists them too. Keep a record kind in the brief when the system uses it, and do not treat it as something to create. A name that exists is updated when its properties, form fields, or operations differ from what the user asked for. Call update_plan with that change. Say the space is already configured only when it already does what they asked for.
Do not call propose_change. After update_plan, stop.
"""

_SURFACE = """
You are consulting on the open plan. update_plan may confirm an input, describe a simulation, or drop an assumption.
If the user is choosing or changing the routine, a type, a link, the path, the outputs, the operations, or the screens, call update_plan with those changed sections. The planner revises the brief. Do not record that change only by clearing an open question. If their message answers the open question, call update_plan with what they chose. Do not ask that question again.
propose_change is not available while the plan is open. Ask the one blocking question the tool result names.
"""


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


def _session_reads_for_turn(
    principal: Principal,
    space_id: str,
    thread_id: str | None,
    follow_up: bool,
    session_context: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Snapshot for a new thread's first message. A follow-up does not consume it."""
    if follow_up:
        return None
    if isinstance(session_context, dict) and session_context:
        return session_context
    if thread_id is None and session_context is None:
        return chat_tools.take_session_reads(principal, space_id)
    return None


def _prefix_session_snapshot(messages: list[dict[str, Any]], reads: dict[str, Any]) -> None:
    """Attach the snapshot to the model copy of the user message, not the transcript."""
    block = chat_tools.format_session_snapshot(reads)
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        message["content"] = f"{block}\n\nUser message:\n{message.get('content') or ''}"
        return


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


def _plan_preview(
    principal: Principal, space_id: str, brief: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fitted brief plus the proposal preview. A compile error does not open a batch."""
    try:
        fitted = chat_plan.preview_for_brief(space_id, brief)
    except ValueError as exc:
        return brief, {
            "items": [],
            "error": str(exc),
            "problems": [],
            "already": [],
            "conflicts": [],
            "configured": False,
        }
    return fitted["brief"], {
        "items": [_public_item(item) for item in fitted["items"]],
        "problems": chat_plan.validation_problems(principal, space_id, fitted["items"]),
        "already": fitted["already"],
        "conflicts": fitted["conflicts"],
        "configured": fitted["configured"],
    }


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
    inputs = item.get("inputs") if isinstance(item.get("inputs"), list) else []
    if inputs:
        public["inputs"] = inputs
    return public


def run_turn(
    *,
    space_id: str,
    principal: Principal,
    content: str,
    thread_id: str | None,
    model: tuple[dict[str, Any], str] | None = None,
    models: dict[str, tuple[dict[str, Any], str]] | None = None,
    complete=None,
    session_context: dict[str, Any] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield SSE-shaped events. Persists the thread even if the client disconnects.

    ``models`` maps ``surface``, ``planner``, and ``builder`` to request configs.
    Without it, the single ``model`` runs the whole turn and no route is chosen.
    A missing builder config uses the planner.
    """
    text = (content or "").strip()
    if not text:
        raise ValueError("message is required")
    if models:
        resolved = models["surface"]
    else:
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
        messages: list[dict[str, Any]] = [{"role": "system", "content": ""}]
        messages.extend(_history(prior.get("messages") or []))
        follow_up = text.startswith(_FOLLOW_UP_MARK)
        session_reads = _session_reads_for_turn(
            principal, space_id, thread_id, follow_up, session_context
        )
        if session_reads:
            _prefix_session_snapshot(messages, session_reads)
        active = {"role": "surface", "routing": bool(models) and not follow_up}
        brief_box: dict[str, Any] = {"brief": None, "item_id": None}
        for stacked in reversed(prior.get("stack") or []):
            if stacked.get("kind") != "plan":
                continue
            payload = stacked.get("payload") if isinstance(stacked.get("payload"), dict) else {}
            if payload.get("status") == "confirmed":
                continue
            brief_box["item_id"] = stacked.get("id")
            brief_box["brief"] = payload.get("brief") if isinstance(payload.get("brief"), dict) else None
            brief_box["asked"] = str(payload.get("asked") or "")
            brief_box["payload"] = payload
            break
        if (
            isinstance(brief_box["brief"], dict)
            and brief_box["brief"].get("status") != "confirmed"
        ):
            healed = chat_plan.heal_brief(brief_box["brief"])
            if healed != chat_plan.normalize_brief(brief_box["brief"]):
                brief_box["brief"] = healed
                brief_box["needs_publish"] = True
        if models and follow_up and not (
            isinstance(brief_box["brief"], dict) and brief_box["brief"].get("status") != "confirmed"
        ):
            active["role"] = "builder"
        control = {
            "escalate": False,
            "planner_wrote": False,
            "revised": False,
            "answering": False,
            "skip_model": False,
        }
        name_note: dict[str, str | None] = {"text": None}

        def consulting() -> bool:
            current = brief_box["brief"]
            return isinstance(current, dict) and current.get("status") != "confirmed"

        def refresh_system() -> None:
            note = _SNAPSHOT_NOTE if session_reads else _CATALOG_NOTE
            parts = [_SYSTEM.format(space_id=space_id, catalog_note=note)]
            if not follow_up and models and active["routing"]:
                parts.append(_ROUTE)
            elif models and active["role"] == "planner":
                parts.append(_PLANNER)
                if name_note["text"] is None:
                    name_note["text"] = chat_plan.space_names_note(space_id)
                if name_note["text"]:
                    parts.append(name_note["text"])
            elif models and active["role"] == "builder":
                parts.append(_BUILDER)
            elif models and not follow_up and consulting():
                parts.append(_SURFACE)
            elif not models:
                parts.append(_BUILDER)
            plan_brief = brief_box["brief"]
            if not follow_up and isinstance(plan_brief, dict) and plan_brief.get("status") != "confirmed":
                parts.append(
                    "The open plan brief is:\n" + json.dumps(plan_brief, default=str)
                )
            messages[0]["content"] = "\n".join(parts)

        def current_pair() -> tuple[dict[str, Any], str]:
            if not models:
                return model_cfg, api_key
            pair = models.get(active["role"])
            if pair is None and active["role"] == "builder":
                pair = models.get("planner")
            if pair is None:
                pair = models["surface"]
            return pair

        def current_tools() -> list[dict[str, Any]]:
            if not models:
                tools = chat_tools.TOOLS
            else:
                tools = chat_tools.select_tools(
                    role=active["role"], consulting=consulting(), routing=active["routing"]
                )
            if not session_reads:
                return tools
            # A failed read stays callable so the model can try it once more.
            skip = {
                name
                for name, result in session_reads.items()
                if not (isinstance(result, dict) and result.get("ok") is False)
            }
            return [tool for tool in tools if tool["function"]["name"] not in skip]

        def answering_open_question() -> bool:
            """The user is replying to the planner's question, not confirming a source."""
            if not models or follow_up or not consulting():
                return False
            question = chat_plan.planner_question(brief_box["brief"]).strip()
            if not question or chat_plan.is_slot_question(question):
                return False
            if str(brief_box.get("asked") or "").strip() == question:
                return True
            for message in reversed(messages):
                if message.get("role") != "assistant":
                    continue
                return question in str(message.get("content") or "")
            return False

        if answering_open_question():
            control["answering"] = True
            control["answered_question"] = chat_plan.planner_question(brief_box["brief"]).strip()
            active["role"] = "planner"
            active["routing"] = False

        refresh_system()

        def one_round(tools: list[dict[str, Any]] | None = None) -> tuple[str, str, list[dict[str, Any]]]:
            round_text = ""
            round_thought = ""
            found: list[dict[str, Any]] = []
            pair_cfg, pair_key = current_pair()
            for piece in runner(pair_cfg, pair_key, messages, current_tools() if tools is None else tools):
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
                if control["escalate"]:
                    break
                name = str(call.get("name") or "")
                arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                yield_tool(name, arguments, call)

        tool_events: list[dict[str, Any]] = []

        def _cap(pair: tuple[dict[str, Any], str]) -> int:
            return chat_store.clamp_max_rounds(pair[0].get("max_rounds"))

        if models:
            builder_pair = models.get("builder") or models["planner"]
            caps = {
                "surface": _cap(models["surface"]),
                "planner": _cap(models["planner"]),
                "builder": _cap(builder_pair),
            }
        else:
            one_cap = _cap((model_cfg, api_key))
            caps = {"surface": one_cap, "planner": one_cap, "builder": one_cap}
        role_rounds = {"surface": 0, "planner": 0, "builder": 0}
        message_checkpoint = len(messages)
        summary_checkpoint = 0

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

        def publish_plan(plan_brief: dict[str, Any], blocking: list[str]) -> None:
            plan_brief, preview = _plan_preview(principal, space_id, plan_brief)
            blocking = chat_plan.readiness(plan_brief)
            brief_box["brief"] = plan_brief
            payload = {
                "status": plan_brief.get("status") or "consulting",
                "brief": plan_brief,
                "blocking": blocking,
                "ready": not blocking and plan_brief.get("status") != "confirmed",
                "preview": preview,
            }
            if brief_box.get("asked"):
                payload["asked"] = brief_box["asked"]
            brief_box["payload"] = payload
            if brief_box["item_id"] is None:
                item = chat_store.add_stack_item(tid, "plan", "Plan", payload)
                brief_box["item_id"] = item["id"]
                tool_events.append({"event": "canvas", "data": {"item": item}})
                return
            item = chat_store.update_stack_item(tid, brief_box["item_id"], payload=payload)
            if item is not None:
                tool_events.append({"event": "canvas_update", "data": {"item": item}})

        def remember_asked(question: str) -> None:
            question = question.strip()
            if not question or not brief_box.get("item_id"):
                return
            brief_box["asked"] = question
            payload = dict(brief_box.get("payload") or {})
            if payload.get("asked") == question:
                return
            payload["asked"] = question
            brief_box["payload"] = payload
            item = chat_store.update_stack_item(tid, brief_box["item_id"], payload=payload)
            if item is not None:
                tool_events.append({"event": "canvas_update", "data": {"item": item}})

        def yield_tool(name: str, arguments: dict[str, Any], call: dict[str, Any]) -> None:
            outcome = None
            if name == "update_plan":
                plan_role = active["role"] if models else "planner"
                result = chat_plan.update_brief(brief_box["brief"], arguments, plan_role)
                if result.get("escalate"):
                    control["escalate"] = True
                    outcome = chat_tools.ToolResult(
                        {"ok": False, "escalate": True, "error": result.get("error")}
                    )
                else:
                    brief_box["brief"] = result["brief"]
                    control["revised"] = True
                    if plan_role == "planner":
                        control["planner_wrote"] = True
                    publish_plan(result["brief"], list(result.get("blocking") or []))
                    outcome = chat_tools.ToolResult(
                        {
                            "ok": True,
                            "ready": result["ready"],
                            "blocking": result["blocking"],
                            "brief": result["brief"],
                        }
                    )
            elif (
                name == "propose_change"
                and models
                and active["role"] == "surface"
                and chat_plan.is_build_kind(str(arguments.get("kind") or ""))
            ):
                control["escalate"] = True
                outcome = chat_tools.ToolResult(
                    {
                        "ok": False,
                        "escalate": True,
                        "error": "Building a routine is a planner turn. The planner will revise the brief.",
                    }
                )
            if outcome is None:
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
                    "max": caps[active["role"]],
                    "role": active["role"] if models else "",
                    "text": round_text,
                    "thought": round_thought,
                    "tools": [str(call.get("name") or "") for call in calls],
                }
            )
            publish_reasoning()

        def route_of(calls: list[dict[str, Any]]) -> str:
            for call in calls:
                if str(call.get("name") or "") != "choose_route":
                    continue
                arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                route = str(arguments.get("route") or "surface").strip().lower()
                return "deep" if route == "deep" else "surface"
            return "surface"

        def rewind_surface_turn() -> None:
            del messages[message_checkpoint:]
            del tool_summaries[summary_checkpoint:]
            proposals.clear()
            control["escalate"] = False
            control["revised"] = False
            active["role"] = "planner"
            active["routing"] = False
            refresh_system()

        if brief_box.get("needs_publish") and isinstance(brief_box["brief"], dict):
            publish_plan(brief_box["brief"], chat_plan.readiness(brief_box["brief"]))

        def line_user_was_asked() -> str:
            stored = str(brief_box.get("asked") or "").strip()
            if stored:
                return stored if chat_plan.is_records_question(stored) else ""
            for message in reversed(messages):
                if message.get("role") != "assistant":
                    continue
                content = str(message.get("content") or "")
                for question in (chat_plan.RECORD_KINDS_QUESTION, chat_plan.LEGACY_RECORD_KINDS_QUESTION):
                    if question in content:
                        return question
                return ""
            return ""

        if (
            not follow_up
            and isinstance(brief_box["brief"], dict)
            and chat_plan.is_records_question(line_user_was_asked())
        ):
            labels = chat_plan.record_labels(_model_text(text))
            if labels:
                brief_box["brief"] = chat_plan.add_record_kinds(brief_box["brief"], labels)
                publish_plan(brief_box["brief"], chat_plan.readiness(brief_box["brief"]))
                control["revised"] = True
                control["planner_wrote"] = True
            else:
                reply, follow = chat_plan.records_explanation(brief_box["brief"])
                if follow:
                    remember_asked(follow)
                yield {"event": "text", "data": {"delta": reply}}
            control["skip_model"] = True

        safety = max(caps.values()) + 3
        produced = 0
        while produced < safety and not control["skip_model"]:
            role = active["role"]
            if role_rounds[role] >= caps[role]:
                break
            role_rounds[role] += 1
            produced += 1
            reply_mark = len(reply)
            yield {"event": "round", "data": {"index": role_rounds[role], "max": caps[role]}}
            round_text, round_thought, calls = one_round()
            if active["routing"]:
                if not calls:
                    yield from take_text()
                    note_round(role_rounds[role], round_text, round_thought, calls)
                    yield from tool_events
                    tool_events.clear()
                    break
                chosen = route_of(calls)
                active["routing"] = False
                if chosen == "deep":
                    pending_text.clear()
                else:
                    yield from take_text()
                note_round(role_rounds[role], round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
                if chosen == "deep":
                    active["role"] = "planner"
                elif consulting():
                    active["role"] = "surface"
                else:
                    active["role"] = "builder"
                refresh_system()
                continue
            if not calls:
                yield from take_text()
                note_round(role_rounds[role], round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
                break
            run_calls(calls, round_text)
            if control["escalate"]:
                pending_text.clear()
                tool_events.clear()
                note_round(role_rounds[role], round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
                reply = reply[:reply_mark]
                rewind_surface_turn()
                continue
            yield from take_text()
            note_round(role_rounds[role], round_text, round_thought, calls)
            yield from tool_events
            tool_events.clear()
            if control["revised"]:
                break
        plan_ready = (
            models
            and isinstance(brief_box["brief"], dict)
            and (control["planner_wrote"] or (consulting() and control["revised"]))
        )
        if not reply.strip() and not plan_ready:
            # A tool-only finish looks like a freeze: the tools are listed and then nothing.
            if active["routing"]:
                nudge = (
                    "Call choose_route now. deep when the user is describing or changing a routine, "
                    "a type, or a decision. surface when they are confirming a source or asking what exists."
                )
            elif follow_up and "check_console_modules" in text:
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
            elif consulting() or active["role"] == "planner":
                nudge = (
                    "If the user is changing the routine, a type, a link, the outputs, the operations, or the screens, "
                    "call update_plan with those sections. "
                    "If they are confirming a source, call update_plan with that input. "
                    "Otherwise ask the one blocking question."
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
                if control["escalate"]:
                    pending_text.clear()
                    tool_events.clear()
                    reply = ""
                    rewind_surface_turn()
                    round_text, round_thought, calls = one_round()
                    if calls:
                        run_calls(calls, round_text)
                    yield from take_text()
                    note_round(len(reasoning_rounds) + 1, round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
        plan_ready = (
            models
            and isinstance(brief_box["brief"], dict)
            and (control["planner_wrote"] or (consulting() and control["revised"]))
        )
        answered = str(control.get("answered_question") or "").strip()
        if answered and isinstance(brief_box["brief"], dict):
            current = chat_plan.consultation_question(brief_box["brief"]).strip()
            if current == answered and not control["planner_wrote"]:
                active["role"] = "planner"
                active["routing"] = False
                refresh_system()
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "The user answered the open question. Update the brief from their message "
                            "and remove that question. If they said they do not know, adopt the example "
                            "already named in the question, record it as an assumption, and remove the question. "
                            "Do not ask it again.\n"
                            f"{answered}"
                        ),
                    }
                )
                round_text, round_thought, calls = one_round()
                yield from take_text()
                if calls:
                    run_calls(calls, round_text)
                    yield from take_text()
                note_round(len(reasoning_rounds) + 1, round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
                current = chat_plan.consultation_question(brief_box["brief"]).strip()
            if current == answered:
                retired = chat_plan.drop_open_question(brief_box["brief"], answered)
                moved = chat_plan.consultation_question(retired).strip()
                if moved != answered:
                    brief_box["brief"] = retired
                    publish_plan(retired, chat_plan.readiness(retired))
                    control["revised"] = True
                    plan_ready = True
                    current = moved
            if current != answered and answered in reply:
                reply = ""
            plan_ready = (
                models
                and isinstance(brief_box["brief"], dict)
                and (control["planner_wrote"] or (consulting() and control["revised"]))
            )
        if plan_ready:
            question = chat_plan.consultation_question(brief_box["brief"])
            if question and question not in reply and not control["skip_model"]:
                active["role"] = "surface"
                active["routing"] = False
                refresh_system()
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Ask the user only this question, with no tool call. "
                            "Say the plan is on the canvas, then ask:\n"
                            f"{question}"
                        ),
                    }
                )
                try:
                    round_text, round_thought, calls = one_round([])
                except Exception:
                    pending_text.clear()
                    round_text, round_thought, calls = "", "", []
                yield from take_text()
                note_round(len(reasoning_rounds) + 1, round_text, round_thought, calls)
                yield from tool_events
                tool_events.clear()
            missing: list[str] = []
            if "plan is on the canvas" not in reply.lower():
                missing.append("The plan is on the canvas.")
            if question and question not in reply:
                missing.append(question)
            elif not question and "confirm it when it looks right" not in reply.lower():
                missing.append("Confirm it when it looks right.")
            if missing:
                addition = " ".join(missing)
                delta = f" {addition}" if reply.strip() else addition
                reply = f"{reply}{delta}".strip()
                yield {"event": "text", "data": {"delta": delta}}
            if question:
                remember_asked(question)
            elif control["skip_model"]:
                remember_asked("Confirm it when it looks right.")
        if not reply.strip():
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Reply to the user now, with no tool call. "
                        "Say where things stand, or ask one question."
                    ),
                }
            )
            try:
                round_text, round_thought, calls = one_round([])
            except Exception:
                pending_text.clear()
                round_text, round_thought, calls = "", "", []
            yield from take_text()
            note_round(len(reasoning_rounds) + 1, round_text, round_thought, calls)
            yield from tool_events
            tool_events.clear()
        if not reply.strip():
            if text.startswith(_FOLLOW_UP_MARK):
                reply = "Those changes are in. What should we do next?"
            elif consulting() and isinstance(brief_box["brief"], dict):
                question = chat_plan.consultation_question(brief_box["brief"]).strip()
                reply = (
                    f"The plan is on the canvas. {question}"
                    if question
                    else "The plan is on the canvas. Confirm it when it looks right."
                )
            elif proposals:
                reply = "Those changes are ready for you to accept."
            else:
                names: list[str] = []
                for summary in tool_summaries:
                    name = str(summary.get("summary") or summary.get("name") or "").strip()
                    if name and name not in names:
                        names.append(name)
                if names:
                    reply = f"I checked {', '.join(names[:4])}. What should we do next?"
                else:
                    reply = "What should we do next?"
            yield {"event": "text", "data": {"delta": reply}}
        flush_deferred_canvases()
        yield from tool_events
        tool_events.clear()
        # Another model round here resends every tool call. Gemini 4 rejects that
        # follow-up with a generic 400 once the proposal is large, and the turn
        # then ends with no proposal. Show this batch instead.
        chat_apply.supply_implied_inputs(proposals)
        problems = chat_apply.input_inventory_problems(proposals)
        blocking = [problem for problem in problems if chat_apply.input_problem_blocks_accept(problem)]
        if problems:
            note = " " + " ".join(problems)
            reply = f"{reply}{note}".strip()
            yield {"event": "text", "data": {"delta": note}}
        batch = None
        if proposals:
            batch = {"status": "pending", "items": [_public_item(item) for item in proposals]}
            named_inputs = chat_apply.collect_inputs(proposals)
            if named_inputs:
                batch["inputs"] = named_inputs
            if blocking:
                batch["problems"] = blocking
            proposal_payload = {"status": "pending", "items": batch["items"]}
            if named_inputs:
                proposal_payload["inputs"] = named_inputs
            if blocking:
                proposal_payload["problems"] = blocking
            proposal = chat_store.add_stack_item(
                tid,
                "proposal",
                "Proposed changes",
                proposal_payload,
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
