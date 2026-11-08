"""Tools the in-app agent can call.

Reads and sequence runs happen immediately, as the signed-in user. Canvas tools
record a stack item for the client. propose_change only queues a batch item.
"""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi.exceptions import HTTPException

from . import (
    agent_keys,
    auth,
    catalog,
    chat_apply,
    chat_store,
    console_check,
    credentials,
    embeddings,
    graph,
    id_generator,
    rbac,
    sequence_service,
    spaces,
)
from .auth import Principal

_MODULE_TYPES = {
    "stat",
    "text",
    "table",
    "badge",
    "progress",
    "ring",
    "graph",
    "line",
    "bar",
    "area",
    "donut",
    "alert",
    "button",
    "switch",
    "checkbox",
    "segmented",
    "select",
    "number",
    "form",
}

_OBJECT = {"type": "object", "properties": {}, "additionalProperties": False}
_SETTINGS_TABS = (
    "settings",
    "chat",
    "users",
    "agents",
    "credentials",
    "embeddings",
    "templates",
    "audit",
    "account",
    "update",
)
_MANAGE_TABS = {"chat", "users", "agents", "credentials", "embeddings", "templates"}
_WALKTHROUGH_VIEWS = {"workbench", "sequence", "event", "console"}

_MODULE_ITEM = {
    "type": "object",
    "properties": {
        "type": {"type": "string"},
        "title": {"type": "string"},
        "data_sequence_id": {
            "type": "string",
            "description": "Sequence or read operation id or name. Its result is what the module draws.",
        },
        "data_url": {"type": "string"},
        "action_sequence_id": {"type": "string"},
        "fields": {
            "type": "string",
            "description": "JSON array of form fields, each with name, label, and type.",
        },
        "config": {"type": "object"},
    },
}


def _params(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _tool(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {"name": name, "description": description, "parameters": parameters},
    }


TOOLS: list[dict[str, Any]] = [
    _tool("list_spaces", "List spaces this user can open.", _OBJECT),
    _tool(
        "describe_space",
        "Name, description, and registered attributive labels for the current space.",
        _OBJECT,
    ),
    _tool(
        "describe_settings",
        "Current space settings the proposal may need to change: space record, chat model "
        "(no API key), embeddings config, credential names, roles, and agent-key names.",
        _OBJECT,
    ),
    _tool(
        "open_settings",
        "Open one settings tab on the canvas. The user can use that screen. "
        "tab is settings, chat, users, agents, credentials, embeddings, templates, audit, account, or update.",
        _params(
            {"tab": {"type": "string", "enum": list(_SETTINGS_TABS)}},
            ["tab"],
        ),
    ),
    _tool(
        "list_catalog",
        "Saved operations and sequences (id, name, kind). Omit cypher; call get_catalog_item for one.",
        _params({"kind": {"type": "string", "enum": ["operation", "sequence", "all"]}}),
    ),
    _tool(
        "get_catalog_item",
        "One saved operation or sequence package.",
        _params({"id": {"type": "string"}}, ["id"]),
    ),
    _tool("list_events", "Events in the current space.", _OBJECT),
    _tool(
        "get_event",
        "One event, including its package.",
        _params({"id": {"type": "string"}}, ["id"]),
    ),
    _tool("list_consoles", "Consoles in the current space.", _OBJECT),
    _tool(
        "get_console",
        "One console, including its document.",
        _params({"id": {"type": "string"}}, ["id"]),
    ),
    _tool("list_schemas", "SCHEMA nodes in the current space.", _OBJECT),
    _tool(
        "describe_schema",
        "One SCHEMA definition.",
        _params({"attributive_label": {"type": "string"}}, ["attributive_label"]),
    ),
    _tool("list_steps", "STEP nodes in the current space.", _OBJECT),
    _tool(
        "run_sequence",
        "Run a sequence now. A pause for more input opens a form on the canvas.",
        _params(
            {
                "sequence_id": {"type": "string"},
                "params": {"type": "object"},
                "state_id": {"type": "string", "description": "Resume a paused run."},
            },
            ["sequence_id"],
        ),
    ),
    _tool(
        "open_console",
        "Open a saved console on the canvas. The user can use it, including its run buttons. "
        "The result includes a check of what each module shows, or which sequence it runs.",
        _params({"console_id": {"type": "string"}}, ["console_id"]),
    ),
    _tool(
        "check_console_modules",
        "Run each module's data sequence the way the console does, and report what that module would show. "
        "For a button, switch, or form, report the sequence it runs on submit. This does not execute action sequences. "
        "Pass a saved console_id, or the modules you are about to open. "
        "ok is false when a module would show the expected-shape placeholder, or when an action module has no sequence to run. "
        "A sequence that is not in the catalog yet cannot be checked.",
        _params(
            {
                "console_id": {"type": "string"},
                "modules": {"type": "array", "items": _MODULE_ITEM},
                "document": {
                    "type": "object",
                    "description": "A console document with views. Use this or modules or console_id.",
                },
            }
        ),
    ),
    _tool(
        "open_ephemeral_console",
        "Open a working console on the canvas now. It runs existing sequences. "
        "Do not call this for a console whose sequences, events, or schemas are still a proposal: "
        "that console cannot run until the user accepts. Propose upsert_console instead, and open the console only after acceptance. "
        "Bind data_sequence_id to a sequence or read operation (id or name) so the module shows that result, not an example. "
        "This refuses to open when a module would show the expected-shape placeholder or would not run its sequence. "
        "The result says what each module shows, or which sequence it runs.",
        _params(
            {
                "title": {"type": "string"},
                "modules": {"type": "array", "items": _MODULE_ITEM},
            },
            ["title"],
        ),
    ),
    _tool(
        "open_builder",
        "Open a read-only sequence, schema, or event view on the canvas. There is no save button.",
        _params(
            {
                "kind": {"type": "string", "enum": ["sequence", "schema", "event"]},
                "id": {"type": "string", "description": "Catalog id, or a schema attributive label."},
            },
            ["kind", "id"],
        ),
    ),
    _tool(
        "show_walkthrough",
        "Show a scrubbable view of screens that already exist. Does not write. "
        "Do not use a console frame for a console that is not saved yet: the proposal shows that configuration, "
        "and a live console cannot run until the user accepts. "
        "Each frame has view (workbench, sequence, event, or console), title, note, "
        "pins (target is a property key, step label, event field, or console module id), "
        "and document as a JSON string of the query, event package, or console document.",
        _params(
            {
                "title": {"type": "string"},
                "frames": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "view": {
                                "type": "string",
                                "enum": ["workbench", "sequence", "event", "console"],
                            },
                            "title": {"type": "string"},
                            "note": {"type": "string"},
                            "pins": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "target": {"type": "string"},
                                        "note": {"type": "string"},
                                    },
                                    "required": ["target"],
                                },
                            },
                            "document": {
                                "type": "string",
                                "description": "JSON object for this view. An event is {name, type, timezone, sequences, recovery_sequences, event_package: {timezone, groups: [{is_time: \"18:00\", is_weekday: [1,2,3,4,5]}]}}. is_time is 24-hour HH:MM. is_weekday is 1-7, Monday through Sunday. A query with no match graph is {name, operation, kind, cypher}. These fields are what the preview shows.",
                            },
                        },
                        "required": ["view", "document"],
                    },
                },
            },
            ["frames"],
        ),
    ),
    _tool(
        "propose_change",
        "Queue a write for the user to accept or reject with the rest of this turn. "
        "Does not change the space. The user sees a list and can expand each item into a read-only copy of that config. "
        "Fill the payload with the real configuration, not only a summary. "
        "note is one sentence inserted in that config. "
        "pins annotate fields inside it: target is a property key, an event field "
        "(name, event_type, secret, filters, mappings, sequences, recovery, timezone), "
        "a sequence id, or a console module id. "
        + chat_apply.KIND_HELP,
        _params(
            {
                "kind": {
                    "type": "string",
                    "enum": [
                        "create_space",
                        "upsert_schema",
                        "upsert_query",
                        "create_transition",
                        "update_space",
                        "upsert_credential",
                        "update_chat_model",
                        "update_embeddings",
                        "reindex_embeddings",
                        "invite_member",
                        "update_member",
                        "update_role",
                        "create_agent_key",
                        "revoke_agent_key",
                        "update_tab_chrome",
                        "upsert_event",
                        "delete_event",
                        "upsert_console",
                        "delete_console",
                        "delete_sequence",
                        "delete_operation",
                        "delete_step",
                        "delete_schema",
                    ],
                },
                "summary": {"type": "string"},
                "note": {
                    "type": "string",
                    "description": "One sentence inserted in the read-only config for this item.",
                },
                "pins": {
                    "type": "array",
                    "description": "Annotations placed on fields inside the read-only config.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target": {"type": "string"},
                            "note": {"type": "string"},
                        },
                        "required": ["target"],
                    },
                },
                "payload": {"type": "object"},
                "inputs": {
                    "type": "array",
                    "description": (
                        "Each way data enters this process. Required on one call when the batch "
                        "creates an event, seeds rows, or a console someone fills in. "
                        "source person lands_as console. source clock lands_as time_event. "
                        "source external lands_as external_event. "
                        "source simulated lands_as simulated_event or console. "
                        "source seed lands_as execute_package. "
                        "If the user did not name a live source, use simulated or a console."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "source": {
                                "type": "string",
                                "enum": ["person", "clock", "external", "simulated", "seed"],
                            },
                            "lands_as": {
                                "type": "string",
                                "enum": [
                                    "console",
                                    "time_event",
                                    "external_event",
                                    "simulated_event",
                                    "execute_package",
                                ],
                            },
                        },
                        "required": ["name", "source", "lands_as"],
                    },
                },
            },
            ["kind", "summary", "payload"],
        ),
    ),
    _tool(
        "choose_route",
        "Choose which model continues this turn. Call this before any other tool. "
        "deep when the user is describing or changing the system, a record kind, an operation, a screen, or a decision. "
        "Choosing or changing any of those is deep, even when they are answering a question. "
        "Answering the open question is deep, including when they say they do not know. "
        "surface when they are confirming a source, describing a simulation, dropping an assumption, "
        "or asking what already exists.",
        _params(
            {
                "route": {"type": "string", "enum": ["surface", "deep"]},
                "reason": {"type": "string"},
            },
            ["route"],
        ),
    ),
    _tool(
        "update_plan",
        "Revise the consultation brief. Does not write the space. "
        "The planner may set routine, reconstruction, ontology, multi_hop, outputs, operations, screens, vector, inputs, and open_questions. "
        "When a plan is open, send only the sections that change. "
        "The surface model may confirm an input, set a simulation, or drop an assumption. "
        "A surface change to the routine, types, links, path, outputs, operations, or screens is handed to the planner, "
        "as is a surface update that does not touch an input or an assumption.",
        _params(
            {
                "routine": {"type": "string"},
                "reconstruction": {"type": "object"},
                "ontology": {"type": "object"},
                "multi_hop": {"type": "object"},
                "inputs": {"type": "array", "items": {"type": "object"}},
                "outputs": {"type": "array", "items": {"type": "object"}},
                "operations": {"type": "array", "items": {"type": "object"}},
                "screens": {"type": "array", "items": {"type": "object"}},
                "vector": {"type": "object"},
                "assumptions": {"type": "array", "items": {"type": "object"}},
                "rejected": {"type": "array", "items": {"type": "string"}},
                "open_questions": {"type": "array", "items": {"type": "object"}},
            },
        ),
    ),
]


def select_tools(*, role: str, consulting: bool, routing: bool) -> list[dict[str, Any]]:
    """The tools for this turn. Routing offers only the choice. A planner cannot propose."""
    if routing:
        return [tool for tool in TOOLS if tool["function"]["name"] == "choose_route"]
    selected: list[dict[str, Any]] = []
    for tool in TOOLS:
        name = tool["function"]["name"]
        if name == "choose_route":
            continue
        if role == "planner":
            if name == "update_plan" or name.startswith(("list_", "get_", "describe_")):
                selected.append(tool)
            continue
        if role != "builder" and consulting and name == "propose_change":
            continue
        selected.append(tool)
    return selected


class ToolResult:
    def __init__(
        self,
        result: dict[str, Any],
        canvases: list[dict[str, Any]] | None = None,
        proposal: dict[str, Any] | None = None,
    ) -> None:
        self.result = result
        self.canvases = canvases or []
        self.proposal = proposal


def _json_object(value: Any) -> dict[str, Any]:
    """A frame document arrives as an object, or as a JSON string from Gemini."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError as exc:
            raise ValueError("frame document must be a JSON object") from exc
        if isinstance(parsed, dict):
            return parsed
        raise ValueError("frame document must be a JSON object")
    return {}


def _walkthrough_frames(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("show_walkthrough needs at least one frame")
    frames: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        view = str(entry.get("view") or "").strip()
        if view not in _WALKTHROUGH_VIEWS:
            raise ValueError(f"frame view must be one of {', '.join(sorted(_WALKTHROUGH_VIEWS))}")
        document = _json_object(entry.get("document"))
        pins = []
        for pin in entry.get("pins") if isinstance(entry.get("pins"), list) else []:
            if not isinstance(pin, dict):
                continue
            target = str(pin.get("target") or "").strip()
            if not target:
                continue
            pins.append({"target": target, "note": str(pin.get("note") or "")})
        frames.append(
            {
                "view": view,
                "title": str(entry.get("title") or view),
                "note": str(entry.get("note") or ""),
                "pins": pins,
                "document": document,
            }
        )
    if not frames:
        raise ValueError("show_walkthrough needs at least one frame")
    return frames


# Reads a new chat session would otherwise spend its first round collecting.
# The composer starts them when the message field is focused, and the first
# message of a thread receives the snapshot.
SESSION_READS: tuple[str, ...] = (
    "describe_space",
    "describe_settings",
    "list_schemas",
    "list_steps",
    "list_catalog",
    "list_consoles",
    "list_events",
)

# Covers composing the first message. A snapshot older than this is gathered again.
_SESSION_READS_TTL_SECONDS = 600
_SESSION_READS_WAIT_SECONDS = 60
_session_lock = threading.Lock()
_session_jobs: dict[tuple[str, str], dict[str, Any]] = {}


def gather_session_reads(principal: Principal, space_id: str) -> dict[str, Any]:
    """Run the session reads in parallel. A failed tool stays in its own result."""
    with catalog.catalog_connection():
        pass

    def one(name: str) -> tuple[str, Any]:
        outcome = execute(name, {}, principal, space_id, [])
        return name, outcome.result

    results: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=len(SESSION_READS)) as pool:
        for name, result in pool.map(one, SESSION_READS):
            results[name] = result
    return results


def format_session_snapshot(reads: dict[str, Any]) -> str:
    """Text block prepended to the first user message the model sees."""
    lines = [
        "Session snapshot gathered before this message. These reads already ran. Do not call them again."
    ]
    for name in SESSION_READS:
        if name not in reads:
            continue
        lines.append(f"{name}: {json.dumps(reads[name], default=str)}")
    return "\n".join(lines)


def begin_session_reads(principal: Principal, space_id: str) -> None:
    """Gather the session reads, or wait for the gather already running.

    A fresh unused snapshot is kept. The caller blocks until it is ready.
    """
    key = (principal.user_id, space_id)
    with _session_lock:
        job = _session_jobs.get(key)
        now = time.monotonic()
        fresh = (
            job is not None
            and job.get("result") is not None
            and not job.get("used")
            and now - float(job["finished"]) < _SESSION_READS_TTL_SECONDS
        )
        if fresh:
            return
        in_flight = job is not None and job.get("result") is None and job.get("error") is None
        if in_flight:
            event = job["event"]
            owner = False
        else:
            event = threading.Event()
            job = {
                "event": event,
                "result": None,
                "error": None,
                "finished": 0.0,
                "used": False,
            }
            _session_jobs[key] = job
            owner = True
    if owner:
        try:
            job["result"] = gather_session_reads(principal, space_id)
        except Exception as exc:
            job["error"] = str(exc)[:500]
        finally:
            job["finished"] = time.monotonic()
            event.set()
    elif not event.wait(_SESSION_READS_WAIT_SECONDS):
        raise TimeoutError("session snapshot timed out")
    if job.get("error"):
        raise RuntimeError(str(job["error"]))
    if job.get("result") is None:
        raise RuntimeError("session snapshot was not ready")


def take_session_reads(principal: Principal, space_id: str) -> dict[str, Any] | None:
    """Return the fresh snapshot once, for the first message of a new thread."""
    key = (principal.user_id, space_id)
    with _session_lock:
        job = _session_jobs.get(key)
        if job is None or job.get("used") or job.get("result") is None:
            return None
        if time.monotonic() - float(job["finished"]) > _SESSION_READS_TTL_SECONDS:
            return None
        job["used"] = True
        return job["result"]


def reset_session_reads() -> None:
    """Drop cached snapshots. Tests use this so cases do not share one."""
    with _session_lock:
        _session_jobs.clear()


def _clip(value: Any, limit: int = 12000) -> Any:
    try:
        text = json.dumps(value, default=str)
    except TypeError:
        text = str(value)
    if len(text) <= limit:
        return value
    return {"truncated": True, "preview": text[:limit]}


def _denied(exc: Exception) -> ToolResult:
    detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
    return ToolResult({"ok": False, "error": str(detail)})


def _brief_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    brief = []
    for node in nodes:
        brief.append(
            {
                "id": node.get("id"),
                "attributive_label": node.get("attributive_label"),
            }
        )
    return brief


def _ephemeral_document(modules: list[Any]) -> dict[str, Any]:
    built = []
    for index, raw in enumerate(modules):
        if not isinstance(raw, dict):
            continue
        module_type = str(raw.get("type") or "table").strip()
        if module_type not in _MODULE_TYPES:
            module_type = "table"
        sequence_id = str(raw.get("data_sequence_id") or raw.get("dataSequenceId") or "").strip()
        action_id = str(raw.get("action_sequence_id") or raw.get("actionSequenceId") or "").strip()
        config = dict(raw["config"]) if isinstance(raw.get("config"), dict) else {}
        fields = raw.get("fields")
        if fields is not None and "fields" not in config:
            config["fields"] = fields if isinstance(fields, str) else json.dumps(fields)
        built.append(
            {
                "id": id_generator.generate_id(),
                "type": module_type,
                "title": str(raw.get("title") or module_type),
                "dataSource": "sequence" if sequence_id else "url",
                "dataUrl": str(raw.get("data_url") or ""),
                "dataSequenceId": sequence_id,
                "actionSource": "sequence" if action_id else "url",
                "actionUrl": "",
                "actionSequenceId": action_id,
                "config": config,
                "layout": {
                    "x": (index % 2) * 6,
                    "y": (index // 2) * 8,
                    "w": 6,
                    "h": 8,
                },
            }
        )
    view_id = id_generator.generate_id()
    return {
        "views": [{"id": view_id, "name": "Live", "kind": "live", "modules": built}],
        "activeViewId": view_id,
    }


def _check_console_modules(
    arguments: dict[str, Any], principal: Principal, space_id: str
) -> ToolResult:
    console_id = str(arguments.get("console_id") or "").strip()
    if console_id:
        console = catalog.get_console(console_id)
        if console is None or str(console.get("space_id") or "") != space_id:
            return ToolResult({"ok": False, "error": "console was not found in this space"})
        document = console.get("document") if isinstance(console.get("document"), dict) else {}
        report = console_check.check_document(
            space_id, document, principal=principal, console_id=console_id
        )
        return ToolResult({"ok": True, "check": report})
    document = arguments.get("document")
    if isinstance(document, dict):
        report = console_check.check_document(
            space_id, document, principal=principal, console_id="check"
        )
        return ToolResult({"ok": True, "check": report})
    modules = arguments.get("modules")
    if not isinstance(modules, list):
        return ToolResult({"ok": False, "error": "Pass a console_id, a document, or modules."})
    built = _ephemeral_document(modules)
    report = console_check.check_document(
        space_id, built, principal=principal, console_id="check"
    )
    return ToolResult({"ok": True, "check": report})


def execute(
    name: str,
    arguments: dict[str, Any],
    principal: Principal,
    space_id: str,
    proposals: list[dict[str, Any]],
) -> ToolResult:
    try:
        if name != "list_spaces":
            auth.require_space_access(principal, space_id)
    except HTTPException as exc:
        return _denied(exc)

    try:
        if name == "list_spaces":
            rows = spaces.fetch_spaces()
            if not principal.is_instance_admin:
                allowed = auth.member_space_ids(principal.user_id)
                rows = [row for row in rows if row.get("id") in allowed]
            return ToolResult(
                {"ok": True, "spaces": [{"id": row["id"], "name": row["name"]} for row in rows]}
            )
        if name == "describe_space":
            record = spaces.fetch_space_record(space_id)
            return ToolResult(
                {
                    "ok": True,
                    "id": record.get("id"),
                    "name": record.get("name"),
                    "description": record.get("description") or "",
                    "labels": record.get("labels") or [],
                    "groups": spaces.fetch_space_groups(space_id),
                }
            )
        if name == "describe_settings":
            record = spaces.fetch_space_record(space_id)
            model = chat_store.get_chat_model(space_id)
            model.pop("api_key", None)
            try:
                embed = embeddings.resolve_config(space_id)
            except ValueError as exc:
                embed = {"error": str(exc)}
            return ToolResult(
                {
                    "ok": True,
                    "space": {
                        "id": record.get("id"),
                        "name": record.get("name"),
                        "endpoint": record.get("endpoint") or "",
                        "description": record.get("description") or "",
                        "dev_mode": bool(record.get("dev_mode")),
                    },
                    "chat_model": model,
                    "embeddings": {
                        key: embed.get(key)
                        for key in (
                            "enabled",
                            "provider",
                            "ollama_url",
                            "base_url",
                            "embed_model",
                            "credential",
                            "dimensions",
                            "source",
                            "error",
                        )
                        if key in embed or key == "enabled"
                    },
                    "credentials": [row.get("name") for row in credentials.list_credentials(space_id)],
                    "roles": [
                        {"id": role.get("id"), "name": role.get("name"), "permissions": role.get("permissions")}
                        for role in rbac.list_roles(space_id)
                    ],
                    "agent_keys": [
                        {"id": key.get("id"), "name": key.get("name"), "revoked": key.get("revoked")}
                        for key in agent_keys.list_keys(space_id)
                    ],
                }
            )
        if name == "open_settings":
            tab = str(arguments.get("tab") or "").strip()
            if tab not in _SETTINGS_TABS:
                return ToolResult({"ok": False, "error": "unknown settings tab"})
            if tab in _MANAGE_TABS:
                try:
                    auth.require_space_manage(principal, space_id)
                except HTTPException as exc:
                    return _denied(exc)
            if tab == "update" and not principal.is_superadmin:
                return ToolResult({"ok": False, "error": "the update tab is limited to the instance superadmin"})
            return ToolResult(
                {"ok": True, "opened": tab},
                canvases=[{"kind": "settings", "title": tab, "payload": {"tab": tab}}],
            )
        if name == "list_catalog":
            wanted = str(arguments.get("kind") or "all").strip()
            rows = []
            for row in catalog.fetch_saved_queries():
                if wanted not in ("", "all") and row.get("kind") != wanted:
                    continue
                rows.append(
                    {
                        "id": row.get("id"),
                        "name": row.get("name"),
                        "kind": row.get("kind"),
                        "operation": row.get("operation"),
                        "suspended": bool(row.get("suspended")),
                        "description": row.get("description") or "",
                        "group_title": row.get("group_title"),
                    }
                )
            return ToolResult(_clip({"ok": True, "items": rows}))
        if name == "get_catalog_item":
            package = catalog.fetch_query_package(str(arguments.get("id") or ""))
            if package is None:
                return ToolResult({"ok": False, "error": "not found"})
            return ToolResult(_clip({"ok": True, "item": package}))
        if name == "list_events":
            events = catalog.list_events(space_id)
            return ToolResult(
                {
                    "ok": True,
                    "events": [
                        {
                            "id": event.get("id"),
                            "name": event.get("name"),
                            "type": event.get("type"),
                            "enabled": event.get("enabled"),
                        }
                        for event in events
                    ],
                }
            )
        if name == "get_event":
            event = catalog.get_event(str(arguments.get("id") or ""))
            if event is None or str(event.get("space_id") or "") != space_id:
                return ToolResult({"ok": False, "error": "event was not found in this space"})
            return ToolResult(_clip({"ok": True, "event": event}))
        if name == "list_consoles":
            consoles = catalog.list_consoles(space_id)
            return ToolResult(
                {
                    "ok": True,
                    "consoles": [
                        {"id": row.get("id"), "name": row.get("name")} for row in consoles
                    ],
                }
            )
        if name == "get_console":
            console = catalog.get_console(str(arguments.get("id") or ""))
            if console is None or str(console.get("space_id") or "") != space_id:
                return ToolResult({"ok": False, "error": "console was not found in this space"})
            return ToolResult(_clip({"ok": True, "console": console}))
        if name == "list_schemas":
            nodes = graph.list_graph_nodes_by_label(space_id, "SCHEMA")
            return ToolResult(_clip({"ok": True, "schemas": _brief_nodes(nodes)}))
        if name == "describe_schema":
            label = str(arguments.get("attributive_label") or arguments.get("id") or "")
            return ToolResult(
                _clip({"ok": True, "schema": graph.fetch_schema_definition(space_id, label)})
            )
        if name == "list_steps":
            nodes = graph.list_graph_nodes_by_label(space_id, "STEP")
            return ToolResult(_clip({"ok": True, "steps": _brief_nodes(nodes)}))
        if name == "run_sequence":
            sequence_id = str(arguments.get("sequence_id") or "").strip()
            auth.require_sequence_run(principal, space_id, sequence_id)
            params = arguments.get("params") if isinstance(arguments.get("params"), dict) else {}
            state_id = str(arguments.get("state_id") or "").strip() or None
            outcome = sequence_service.run_sequence_once(
                space_id,
                sequence_id,
                params=params,
                state_id=state_id,
                trigger="manual",
                principal_id=principal.user_id,
                audit_detail={"source": "chat"},
            )
            canvases = [
                {
                    "kind": "run_log",
                    "title": "Run",
                    "payload": {"sequence_id": sequence_id, "result": outcome},
                }
            ]
            if str(outcome.get("status") or "") == "pending":
                canvases.append(
                    {
                        "kind": "hitl",
                        "title": "Input needed",
                        "payload": {
                            "sequence_id": sequence_id,
                            "state_id": outcome.get("state_id"),
                            "step_id": outcome.get("step_id"),
                            "parameters": outcome.get("parameters") or [],
                        },
                    }
                )
            return ToolResult(_clip({"ok": True, "run": outcome}), canvases=canvases)
        if name == "check_console_modules":
            return _check_console_modules(arguments, principal, space_id)
        if name == "open_console":
            console = catalog.get_console(str(arguments.get("console_id") or ""))
            if console is None or str(console.get("space_id") or "") != space_id:
                return ToolResult({"ok": False, "error": "console was not found in this space"})
            try:
                report = console_check.check_document(
                    space_id,
                    console.get("document") if isinstance(console.get("document"), dict) else {},
                    principal=principal,
                    console_id=str(console["id"]),
                )
            except Exception as exc:
                report = {"ok": False, "summary": str(exc), "modules": []}
            opened: dict[str, Any] = {"ok": True, "opened": console["id"]}
            if report.get("modules"):
                opened["check"] = report
            return ToolResult(
                opened,
                canvases=[
                    {
                        "kind": "saved_console",
                        "title": console.get("name") or "Console",
                        "payload": {"console_id": console["id"]},
                    }
                ],
            )
        if name == "open_ephemeral_console":
            title = str(arguments.get("title") or "Console").strip() or "Console"
            modules = arguments.get("modules") if isinstance(arguments.get("modules"), list) else []
            document = _ephemeral_document(modules)
            report = console_check.check_document(
                space_id,
                document,
                principal=principal,
                console_id="check",
            )
            if document["views"][0]["modules"] and not report["ok"]:
                return ToolResult(
                    {
                        "ok": False,
                        "error": report["summary"],
                        "check": report,
                    }
                )
            opened: dict[str, Any] = {"ok": True, "opened": title}
            if document["views"][0]["modules"]:
                opened["check"] = report
            return ToolResult(
                opened,
                canvases=[
                    {
                        "kind": "ephemeral_console",
                        "title": title,
                        "payload": {"name": title, "document": document},
                    }
                ],
            )
        if name == "open_builder":
            kind = str(arguments.get("kind") or "").strip()
            ident = str(arguments.get("id") or "").strip()
            if kind == "sequence":
                snapshot = catalog.fetch_query_for_compose(ident)
                title = (snapshot or {}).get("name") or "Sequence"
            elif kind == "event":
                snapshot = catalog.get_event(ident)
                if snapshot is not None and str(snapshot.get("space_id") or "") != space_id:
                    snapshot = None
                title = (snapshot or {}).get("name") or "Event"
            elif kind == "schema":
                snapshot = graph.fetch_schema_definition(space_id, ident)
                title = ident or "Schema"
            else:
                return ToolResult({"ok": False, "error": "kind must be sequence, schema, or event"})
            if not snapshot:
                return ToolResult({"ok": False, "error": "not found"})
            return ToolResult(
                {"ok": True, "opened": title},
                canvases=[
                    {
                        "kind": "builder",
                        "title": str(title),
                        "payload": {"builder_kind": kind, "id": ident, "snapshot": snapshot},
                    }
                ],
            )
        if name == "show_walkthrough":
            frames = _walkthrough_frames(arguments.get("frames"))
            title = str(arguments.get("title") or "Proposal").strip() or "Proposal"
            return ToolResult(
                {"ok": True, "opened": title, "frames": len(frames)},
                canvases=[
                    {
                        "kind": "walkthrough",
                        "title": title,
                        "payload": {"title": title, "frames": frames},
                    }
                ],
            )
        if name == "propose_change":
            try:
                item = chat_apply.normalize_item(arguments if isinstance(arguments, dict) else {})
            except ValueError as exc:
                return ToolResult({"ok": False, "errors": [str(exc)]})
            problems = chat_apply.validate_item(principal, space_id, item)
            if problems:
                return ToolResult({"ok": False, "errors": problems})
            proposals.append(item)
            queued: dict[str, Any] = {
                "ok": True,
                "queued": True,
                "summary": item["summary"],
                "preview": item.get("preview"),
            }
            if item.get("module_check"):
                queued["module_check"] = item["module_check"]
            return ToolResult(queued, proposal=item)
    except HTTPException as exc:
        return _denied(exc)
    except Exception as exc:
        return ToolResult({"ok": False, "error": str(exc)})
    return ToolResult({"ok": False, "error": f"Unknown tool {name}"})
