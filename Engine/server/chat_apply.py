"""Validate and apply a chat change batch.

Validation runs before any write. Apply then walks items in dependency order.
A later write that still fails stops the batch and reports what already landed.
There is no rollback engine.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.exceptions import HTTPException

from . import (
    agent_keys,
    auth,
    branding,
    catalog,
    chat_fields,
    chat_store,
    console_check,
    console_service,
    credentials,
    cypher_utils,
    embeddings,
    graph,
    id_generator,
    operation_delete,
    rbac,
    schema_delete,
    schema_update,
    spaces,
    step_delete,
)
from .auth import Principal
from .http_utils import infer_node_label

SETTINGS_KINDS = (
    "update_space",
    "upsert_credential",
    "update_chat_model",
    "update_embeddings",
    "invite_member",
    "update_member",
    "update_role",
    "create_agent_key",
    "revoke_agent_key",
    "update_tab_chrome",
)

AUTHORING_KINDS = (
    "upsert_schema",
    "upsert_query",
    "create_transition",
)

REST_KINDS = (
    "reindex_embeddings",
    "create_space",
    "upsert_event",
    "upsert_console",
    "delete_schema",
    "delete_step",
    "delete_operation",
    "delete_sequence",
    "delete_event",
    "delete_console",
)

APPLY_ORDER = SETTINGS_KINDS + AUTHORING_KINDS + REST_KINDS

KIND_HELP = """
Kinds and payloads. Every field is checked before the item is queued. An error names the field and what it accepts. Do not send cypher, sqlite, builder_config, or a raw query object.
Builder order inside one batch: schema, then the step, then create_transition, then the sequence, then the event or console.
- create_space: {name, description?, endpoint?}
- upsert_schema: {attributive_label, properties?: [{key, value_type, is_required?, is_key?, is_label?, is_indexed?, is_embedded?, format?, options?, default_value?}], is_vectorized?, description?, group_title?, schema_id?, update_existing?}. This saves a create-SCHEMA operation and runs it. The schema keeps attributive_label. Do not reuse that label as a STEP name, sequence entry_step, or operation name. The wrapping STEP is named create_<label>. Exactly one property is the instance display name (is_label true and is_required true); put it on the name-like field. If none is set, name, label, title, display_name, a key ending in _name/_label/_title, or the first string property is marked. An empty property list gets a name property. Pass schema_id and update_existing true to add properties on a schema that already exists. Retained properties keep their value type. Do not send a second create of that label.
- upsert_query kind operation: {id?, name, kind: "operation", operation: create|read|update|delete, node_label: STEP|SCHEMA|INSTANCE, attributive_label?, schema_properties?, instance_properties?: [{key, value}], where?: [{property_key, operator?, value?}], return_items?: [{expression, alias?}], unwind?: {alias, expressions}, set_expressions?: [string], delete_targets?: [string], parameters?: [{name, value_type?, value?, is_required?}], limit?, vector_search?: {enabled, text?, k?, all_labels?}, http_step?, wait_step?, join_step?, operation_step?, add_as_sequence?, execute?, description?, group_title?}. Pass id only to update a saved operation. http_step, wait_step, join_step, and operation_step are mutually exclusive. execute runs a create INSTANCE or SCHEMA package after saving it. A create INSTANCE writes one row. Give the schema key a literal value or a $parameter. unwind is only for a read. To seed several rows, propose one executed create per row. A return alias may be a title; spaces and punctuation become underscores. In a return or SET expression, call the matched node n. A single new STEP is published as a one-step sequence unless add_as_sequence is false.
- upsert_query kind sequence: {id?, name, kind: "sequence", entry_step, traversal?: downstream|single, parameters?: [{name, value}], loop?: {type, count?, condition?, source?, max_iterations?, delay_seconds?, collect?}, description?, group_title?}. entry_step is the STEP attributive_label the run starts at. downstream walks POINTS_TO. Pass id only to update a saved sequence.
- create_transition: {from_step, to_step, relationship_label?, condition_type?: null|parameter|cypher|implicit|query, condition?, condition_expected?}. Both STEP nodes must already exist or be created earlier in this batch.
- update_space: {name, endpoint?, description?, dev_mode?}. name is the current name when you are only changing another field.
- upsert_credential: {name, description?}. Do not send the secret. The user types it on the proposal.
- update_chat_model: {role?: planner|surface|builder, provider?: platform|anthropic|openai|gemini|local_llm, model?, credential_name?, local_llm_base_url?, local_llm_config_id?, max_rounds?}. role defaults to planner. Do not send an API key. A cloud provider must name a credential that already exists.
- update_embeddings: {enabled, provider?, ollama_url?, base_url?, embed_model?, credential?}. credential is a credential name.
- reindex_embeddings: {}. Put this after a vectorized schema in the same batch.
- invite_member: {email, role?}. role is a role id or name.
- update_member: {member_id, role?, is_owner?}.
- update_role: {id?, name, permissions: {flows, sequences, manageSpace}}.
- create_agent_key: {name, role?}. The token is shown to the user once.
- revoke_agent_key: {id}
- update_tab_chrome: {icon_label}. Instance superadmin only.
- upsert_event: {id?, name, type: time|external|simulated, event_package?: {timezone, combinator?, groups: [{is_time: "18:00", is_weekday?: [1-7], is_month?, is_date?}]}, sequences?: [id], recovery_sequences?: [id], enabled?: 1, external_package?: {filters, param_mappings, combinator}}. Weekday 1 is Monday. Put the schedule in groups. A note that says 6pm does not set the time field.
- delete_event: {id}
- upsert_console: {id?, name, trigger_kind?: ""|url|event, listen_url?, trigger_event_id?, document?: {views, activeViewId}}. views is an array of {id, name, kind: live|form, modules, fields?, dataSequenceId?, actionSequenceId?, submitLabel?}. A form view (kind form) puts its fields on the view: {id, name, label, type, required, options?, placeholder?, page?}. A form module puts its fields in config.fields. Pass id to update a console that already exists. Leave trigger_kind empty when a person opens the console. trigger_kind event needs trigger_event_id of a time or external event; with no id the trigger is dropped. A simulated event cannot trigger a console.
- delete_console: {id}
- delete_sequence: {id} removes the catalog sequence only
- delete_operation: {id} deletes the operation, its wrap step, and one-step sequences; suspends multi-step sequences
- delete_step: {attributive_label}
- delete_schema: {attributive_label}
When the batch creates an event, seeds rows, or a console someone fills in, one propose_change call includes inputs: [{name, source: person|clock|external|simulated|seed, lands_as: console|time_event|external_event|simulated_event|execute_package}]. A person or a simulated control lands on a console. A clock lands on a time event. An outside system they have lands on an external event. An outside system they are only describing lands on a simulated event or a console. Invented starting rows land on execute_package. If they did not name a live source, use simulated or a console, not a time or external event.
""".strip()

_STEP_KINDS = ("http_step", "wait_step", "join_step", "operation_step")
_NODE_LABELS = {"STEP", "SCHEMA", "INSTANCE"}
_OPERATIONS = {"create", "read", "update", "delete"}
_CONDITION_TYPES = {"null", "parameter", "cypher", "implicit", "query"}
_CHAT_KEY_PROVIDERS = {"anthropic", "openai", "gemini"}


_SCHEMA_VALUE_TYPES = {
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "UID",
    "radio",
    "checkbox",
}

# Mirrors ensureSchemaLabelProperties in App/authoring/src/schemaRules.ts.
_LABEL_KEY_PREFERENCE = ("name", "label", "title", "display_name")
_LABEL_TEXT_TYPES = {"string", "radio"}


def _schema_label_rank(prop: dict[str, Any], index: int) -> tuple[int, int, int]:
    key = str(prop.get("key") or prop.get("name") or "").strip().lower()
    if key in _LABEL_KEY_PREFERENCE:
        return (0, _LABEL_KEY_PREFERENCE.index(key), index)
    if key.endswith(("_name", "_label", "_title")):
        return (1, index, 0)
    value_type = str(prop.get("value_type") or "string")
    if value_type in _LABEL_TEXT_TYPES:
        return (2, index, 0)
    return (3, index, 0)


def _pick_schema_label(properties: list[dict[str, Any]]) -> dict[str, Any]:
    best = properties[0]
    best_rank = _schema_label_rank(best, 0)
    for index, prop in enumerate(properties):
        rank = _schema_label_rank(prop, index)
        if rank < best_rank:
            best = prop
            best_rank = rank
    return best


def _ensure_schema_label(properties: list[dict[str, Any]]) -> None:
    """Give a node SCHEMA exactly one is_label, without inventing a field seeds omit.

    An empty list gets the builder default ``name`` property. The property that
    keeps is_label is required, matching the schema form.
    """
    labeled = [prop for prop in properties if prop.get("is_label")]
    if len(labeled) == 1:
        labeled[0]["is_required"] = True
        return
    if not properties:
        properties.append(
            schema_update._to_property_schema(
                {
                    "key": "name",
                    "value_type": "string",
                    "is_required": True,
                    "is_key": False,
                    "is_label": True,
                }
            )
        )
        return
    keep = _pick_schema_label(labeled or properties)
    for prop in properties:
        prop["is_label"] = prop is keep
        if prop is keep:
            prop["is_required"] = True


def _schema_properties(raw: Any) -> list[dict[str, Any]]:
    """Property contract for a new SCHEMA, with id and one is_label when omitted."""
    items = raw if isinstance(raw, list) else []
    properties: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            raise ValueError("each schema property must be an object")
        source = entry.get("property_schema") if isinstance(entry.get("property_schema"), dict) else entry
        key = cypher_utils.normalize_attributive_label(
            str(source.get("key") or source.get("name") or "")
        )
        if not key:
            raise ValueError("each schema property requires a key")
        if key == "id":
            raise ValueError('property "id" is added automatically as the key')
        if key in seen:
            raise ValueError(f'duplicate schema property "{key}"')
        if key.lower() in graph.RESERVED_EMBEDDING_PROPERTY_KEYS:
            raise ValueError(f'property "{key}" is reserved and cannot be defined on a SCHEMA')
        value_type = str(source.get("value_type") or "string").strip()
        if value_type not in _SCHEMA_VALUE_TYPES:
            raise ValueError(
                f'property "{key}" value_type must be one of {", ".join(sorted(_SCHEMA_VALUE_TYPES))}'
            )
        seen.add(key)
        constraint = {
            "key": key,
            "value_type": value_type,
            "is_required": bool(source.get("is_required")),
            "is_key": bool(source.get("is_key")),
            "is_label": bool(source.get("is_label")),
            "is_indexed": bool(source.get("is_indexed")),
            "is_embedded": bool(source.get("is_embedded")),
            "format": source.get("format"),
            "options": source.get("options"),
            "min_choices": source.get("min_choices"),
            "max_choices": source.get("max_choices"),
            "default_value": source.get("default_value"),
        }
        properties.append(schema_update._to_property_schema(constraint))
    _ensure_schema_label(properties)
    if not any(prop.get("is_key") for prop in properties):
        properties.insert(
            0,
            schema_update._to_property_schema(
                {
                    "key": "id",
                    "value_type": "UID",
                    "is_required": True,
                    "is_key": True,
                }
            ),
        )
    return properties


def _summary(kind: str, payload: dict[str, Any], given: str) -> str:
    text = (given or "").strip()
    if text:
        return text[:240]
    name = str(payload.get("name") or payload.get("attributive_label") or payload.get("id") or "").strip()
    return f"{kind.replace('_', ' ')} {name}".strip()


def _pins(raw: Any) -> list[dict[str, str]]:
    """Field annotations shown inside the read-only config for this item."""
    if not isinstance(raw, list):
        return []
    pins: list[dict[str, str]] = []
    for pin in raw:
        if not isinstance(pin, dict):
            continue
        target = str(pin.get("target") or "").strip()
        note = str(pin.get("note") or "").strip()
        if not target or not note:
            continue
        pins.append({"target": target[:120], "note": note[:500]})
    return pins


def _normalize_console_trigger(payload: dict[str, Any]) -> None:
    """A console someone opens has no trigger. An event trigger needs an event id.

    ``trigger_kind: event`` with no ``trigger_event_id`` is what a model sends when it
    has no time or external event. Saving that used to fail the whole console.
    """
    if not str(payload.get("trigger_kind") or "").strip() and payload.get("triggerKind"):
        payload["trigger_kind"] = payload.get("triggerKind")
    if not str(payload.get("trigger_event_id") or "").strip() and payload.get("triggerEventId"):
        payload["trigger_event_id"] = payload.get("triggerEventId")
    if not str(payload.get("listen_url") or "").strip() and payload.get("listenUrl"):
        payload["listen_url"] = payload.get("listenUrl")
    kind = str(payload.get("trigger_kind") or "").strip().lower()
    event_id = str(payload.get("trigger_event_id") or "").strip()
    if kind == "event" and not event_id:
        kind = ""
        event_id = ""
    if kind != "event":
        event_id = ""
    payload["trigger_kind"] = kind
    payload["trigger_event_id"] = event_id
    if kind != "url":
        payload["listen_url"] = ""


def normalize_item(raw: dict[str, Any]) -> dict[str, Any]:
    kind = str(raw.get("kind") or "").strip()
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    payload = json.loads(json.dumps(payload, default=str))
    if kind in ("upsert_console", "upsert_event", "upsert_query") and not str(payload.get("id") or "").strip():
        payload["id"] = id_generator.generate_id()
    if kind == "upsert_schema":
        payload["attributive_label"] = cypher_utils.normalize_attributive_label(
            str(payload.get("attributive_label") or payload.get("name") or "")
        )
        payload["properties"] = _schema_properties(payload.get("properties") or payload.get("schemata"))
        payload["is_vectorized"] = bool(payload.get("is_vectorized"))
    if kind == "upsert_query":
        for key in ("attributive_label", "entry_step"):
            if payload.get(key):
                payload[key] = cypher_utils.normalize_attributive_label(str(payload.get(key) or ""))
        if str(payload.get("kind") or "").strip().lower() == "sequence" and not payload.get("traversal"):
            payload["traversal"] = "downstream"
    if kind == "create_transition":
        payload["from_step"] = cypher_utils.normalize_attributive_label(str(payload.get("from_step") or ""))
        payload["to_step"] = cypher_utils.normalize_attributive_label(str(payload.get("to_step") or ""))
    if kind == "upsert_console":
        _normalize_console_trigger(payload)
    item: dict[str, Any] = {
        "kind": kind,
        "summary": _summary(kind, payload, str(raw.get("summary") or "")),
        "payload": payload,
    }
    note = str(raw.get("note") or "").strip()
    if note:
        item["note"] = note[:500]
    pins = _pins(raw.get("pins"))
    if pins:
        item["pins"] = pins
    inputs = normalize_inputs(raw.get("inputs"))
    if inputs:
        item["inputs"] = inputs
    return item


def _console_document_has_modules(document: dict[str, Any]) -> bool:
    views = document.get("views")
    if not isinstance(views, list):
        return False
    for view in views:
        if not isinstance(view, dict):
            continue
        if view.get("kind") == "form":
            return True
        modules = view.get("modules")
        if isinstance(modules, list) and modules:
            return True
    return False


_INPUT_SOURCES = {"person", "clock", "external", "simulated", "seed"}
_INPUT_LANDINGS = {
    "person": {"console"},
    "clock": {"time_event"},
    "external": {"external_event"},
    "simulated": {"simulated_event", "console"},
    "seed": {"execute_package"},
}
_CONSOLE_INPUT_TYPES = {"button", "switch", "checkbox", "segmented", "select", "number", "form"}


def normalize_inputs(raw: Any) -> list[dict[str, str]]:
    """The input list a propose_change call attached, including entries the checker will refuse."""
    if not isinstance(raw, list):
        return []
    inputs: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        inputs.append(
            {
                "name": str(entry.get("name") or "").strip()[:120],
                "source": str(entry.get("source") or "").strip().lower(),
                "lands_as": str(entry.get("lands_as") or "").strip().lower(),
            }
        )
    return inputs


def collect_inputs(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """One entry per name. A later propose_change call replaces an earlier one with the same name."""
    merged: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for item in items:
        for entry in item.get("inputs") or []:
            if not isinstance(entry, dict):
                continue
            key = str(entry.get("name") or "").strip().lower() or f"{entry.get('source')}:{entry.get('lands_as')}"
            if key not in merged:
                order.append(key)
            merged[key] = {
                "name": str(entry.get("name") or "").strip()[:120],
                "source": str(entry.get("source") or "").strip().lower(),
                "lands_as": str(entry.get("lands_as") or "").strip().lower(),
            }
    return [merged[key] for key in order]


def _console_takes_input(document: dict[str, Any]) -> bool:
    views = document.get("views")
    if not isinstance(views, list):
        return False
    for view in views:
        if not isinstance(view, dict):
            continue
        if view.get("kind") == "form":
            return True
        modules = view.get("modules")
        if not isinstance(modules, list):
            continue
        for module in modules:
            if isinstance(module, dict) and str(module.get("type") or "") in _CONSOLE_INPUT_TYPES:
                return True
    return False


def _writes_seed_rows(payload: dict[str, Any]) -> bool:
    """A create INSTANCE operation with execute true writes the invented starting rows.

    propose_change has no execute_package kind. That kind is rejected, and the rows
    are written by an upsert_query whose payload sets execute. A STEP create
    materializes the step itself, so it is not a seed.
    """
    if str(payload.get("kind") or "operation").strip().lower() == "sequence":
        return False
    if str(payload.get("operation") or "").strip().lower() != "create":
        return False
    if str(payload.get("node_label") or "").strip().upper() != "INSTANCE":
        return False
    return payload.get("execute") is True


def _batch_feeds(items: list[dict[str, Any]]) -> dict[str, bool]:
    feeds = {
        "time_event": False,
        "external_event": False,
        "simulated_event": False,
        "execute_package": False,
        "console": False,
    }
    for item in items:
        kind = item.get("kind")
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if kind == "upsert_event":
            event_type = str(payload.get("type") or "time").strip().lower()
            if event_type == "external":
                feeds["external_event"] = True
            elif event_type == "simulated":
                feeds["simulated_event"] = True
            else:
                feeds["time_event"] = True
        elif kind == "upsert_query" and _writes_seed_rows(payload):
            feeds["execute_package"] = True
        elif kind == "execute_package":
            operation = str(payload.get("operation") or "create").strip().lower()
            if operation != "read":
                feeds["execute_package"] = True
        elif kind == "upsert_console":
            document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
            if _console_takes_input(document):
                feeds["console"] = True
    return feeds


def input_inventory_problems(items: list[dict[str, Any]]) -> list[str]:
    """Refuse a batch that feeds the space without an input list that matches those feeds.

    The model names each input. This checks that a person has a console, a clock has a
    time event, an outside system they have has an external event, a described system
    has a simulated event or a console, and invented rows are an executed create INSTANCE
    operation. There is no execute_package change kind.
    """
    feeds = _batch_feeds(items)
    if not any(feeds.values()):
        return []
    inputs = collect_inputs(items)
    if not inputs:
        return [
            "This batch feeds the space but does not name its inputs. "
            "Pass inputs on propose_change: name, source (person, clock, external, simulated, or seed), "
            "and lands_as (console, time_event, external_event, simulated_event, or execute_package)."
        ]
    problems: list[str] = []
    valid: list[dict[str, str]] = []
    for entry in inputs:
        name = entry["name"] or "(unnamed)"
        source = entry["source"]
        lands = entry["lands_as"]
        if not entry["name"]:
            problems.append("Each input needs a name.")
            continue
        if source not in _INPUT_SOURCES:
            problems.append(
                f"Input {name} source must be person, clock, external, simulated, or seed."
            )
            continue
        allowed = _INPUT_LANDINGS[source]
        if lands not in allowed:
            choices = " or ".join(sorted(allowed))
            problems.append(f"Input {name} ({source}) must land as {choices}.")
            continue
        valid.append(entry)

    def lands(kind: str, sources: set[str] | None = None) -> bool:
        return any(
            entry["lands_as"] == kind and (sources is None or entry["source"] in sources)
            for entry in valid
        )

    if feeds["time_event"] and not lands("time_event", {"clock"}):
        problems.append("A time event needs an input with source clock and lands_as time_event.")
    if feeds["external_event"] and not lands("external_event", {"external"}):
        problems.append(
            "An external event needs an input with source external and lands_as external_event. "
            "A source they are only describing is simulated, not external."
        )
    if feeds["simulated_event"] and not lands("simulated_event", {"simulated"}):
        problems.append(
            "A simulated event needs an input with source simulated and lands_as simulated_event."
        )
    if feeds["execute_package"] and not lands("execute_package", {"seed"}):
        problems.append("Seeded rows need an input with source seed and lands_as execute_package.")
    if feeds["console"] and not lands("console", {"person", "simulated"}):
        problems.append(
            "A console someone uses to enter or refresh data needs an input that lands on a console."
        )
    if lands("time_event") and not feeds["time_event"]:
        problems.append("An input lands on a time event, but this batch has no time event.")
    if lands("external_event") and not feeds["external_event"]:
        problems.append("An input lands on an external event, but this batch has no external event.")
    if lands("simulated_event") and not feeds["simulated_event"]:
        problems.append("An input lands on a simulated event, but this batch has no simulated event.")
    if lands("execute_package") and not feeds["execute_package"]:
        problems.append(
            "An input lands on execute_package, but this batch does not seed rows. "
            "Write those rows with an upsert_query create INSTANCE operation and execute true."
        )
    if lands("console") and not feeds["console"]:
        problems.append(
            "An input lands on a console, but this batch has no console someone can enter or refresh."
        )
    return problems


def input_problem_blocks_accept(problem: str) -> bool:
    """A landing that names something this batch does not create is a note, not a veto.

    A follow-up often points at a simulated event, console, or seed that already
    exists. The changes in the batch still apply.
    """
    text = problem or ""
    if "but this batch has no" in text or "but this batch does not seed" in text:
        return False
    return True


def _valid_input_entries(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    valid: list[dict[str, str]] = []
    for entry in collect_inputs(items):
        source = entry["source"]
        if not entry["name"] or source not in _INPUT_SOURCES:
            continue
        if entry["lands_as"] not in _INPUT_LANDINGS[source]:
            continue
        valid.append(entry)
    return valid


_IMPLIED_INPUTS = (
    (
        "execute_package",
        {"seed"},
        {"name": "starting rows", "source": "seed", "lands_as": "execute_package"},
    ),
    (
        "simulated_event",
        {"simulated"},
        {"name": "simulated source", "source": "simulated", "lands_as": "simulated_event"},
    ),
    (
        "console",
        {"person", "simulated"},
        {"name": "console", "source": "person", "lands_as": "console"},
    ),
)


def supply_implied_inputs(items: list[dict[str, Any]]) -> None:
    """Name a seed, a simulated event, or a console when the batch already contains it.

    A clock or an outside system is not invented. Those stay a problem until the
    proposal names a source the user actually has.
    """
    if not items:
        return
    feeds = _batch_feeds(items)
    valid = _valid_input_entries(items)

    def has(kind: str, sources: set[str]) -> bool:
        return any(entry["lands_as"] == kind and entry["source"] in sources for entry in valid)

    missing = [
        dict(entry)
        for kind, sources, entry in _IMPLIED_INPUTS
        if feeds[kind] and not has(kind, sources)
    ]
    if not missing:
        return
    host = items[0]
    host["inputs"] = list(host.get("inputs") or []) + missing


def _error_text(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        return str(detail if isinstance(detail, str) else detail)
    return str(exc)


def _require(principal: Principal, space_id: str, kind: str, payload: dict[str, Any]) -> None:
    if kind == "create_space":
        auth.require_can_create_spaces(principal)
        return
    if kind == "upsert_schema":
        auth.require_flow(principal, space_id, "create", "SCHEMA")
        return
    if kind in ("upsert_event", "delete_event", "upsert_console", "delete_console"):
        auth.require_space_manage(principal, space_id)
        return
    if kind == "upsert_query":
        auth.require_flow(principal, space_id, "create", "STEP")
        return
    if kind == "create_transition":
        auth.require_flow(principal, space_id, "create", "STEP")
        return
    if kind in SETTINGS_KINDS:
        if kind == "update_tab_chrome":
            if not principal.is_superadmin:
                raise ValueError("tab chrome is limited to the instance superadmin")
            return
        auth.require_space_manage(principal, space_id)
        return
    if kind == "reindex_embeddings":
        auth.require_space_manage(principal, space_id)
        return
    if kind == "execute_package":
        operation = str(payload.get("operation") or "create").strip().lower()
        element = infer_node_label(payload)
        auth.require_flow(principal, space_id, operation, element)
        return
    if kind == "delete_sequence":
        auth.require_flow(principal, space_id, "delete", "STEP")
        return
    if kind == "delete_operation":
        auth.require_flow(principal, space_id, "delete", "STEP")
        return
    if kind == "delete_step":
        auth.require_flow(principal, space_id, "delete", "STEP")
        return
    if kind == "delete_schema":
        auth.require_flow(principal, space_id, "delete", "SCHEMA")
        return
    raise ValueError(f"Unknown change kind {kind!r}")


def _reject_authored_escape(payload: dict[str, Any]) -> None:
    present = [key for key in ("cypher", "sqlite", "builder_config", "query") if key in payload]
    if present:
        names = ", ".join(present)
        raise ValueError(
            f"{names} is not a builder field. Describe operation, node_label, properties, "
            "or entry_step instead."
        )


def _role_id(space_id: str, raw: Any) -> str | None:
    text = str(raw or "").strip()
    if not text:
        return None
    for role in rbac.list_roles(space_id):
        if str(role.get("id") or "") == text or str(role.get("name") or "").lower() == text.lower():
            return str(role["id"])
    raise ValueError(f"role {text!r} was not found in this space")


def _credential_names(space_id: str) -> set[str]:
    return {str(row.get("name") or "") for row in credentials.list_credentials(space_id)}


def validate_item(
    principal: Principal,
    space_id: str,
    item: dict[str, Any],
) -> list[str]:
    """Return human-readable problems. Attach a blast-radius preview when one exists."""
    errors: list[str] = []
    kind = item.get("kind") or ""
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    try:
        _require(principal, space_id, kind, payload)
    except (HTTPException, ValueError) as exc:
        return [_error_text(exc)]

    field_errors = chat_fields.payload_problems(str(kind), payload)
    if field_errors:
        return field_errors

    try:
        if kind == "create_space":
            name = str(payload.get("name") or "").strip()
            if not name:
                raise ValueError("name is required")
            spaces.validate_space_name_input(name)
            sid = spaces.normalize_space_name(name)
            with spaces.catalog_db() as conn:
                if spaces._space_name_exists(conn, sid):
                    raise ValueError(f"Space name already exists: {sid!r}")
            item["preview"] = {"creates_space": sid}
        elif kind == "upsert_schema":
            _reject_authored_escape(payload)
            label = str(payload.get("attributive_label") or "").strip()
            if not label:
                raise ValueError("attributive_label is required")
            holders = graph.attributive_label_owner_ids(space_id, label)
            updating = payload.get("update_existing") is True and str(payload.get("schema_id") or "").strip()
            if holders and not updating:
                raise ValueError(
                    f"attributive_label {label!r} is already used by another STEP or SCHEMA"
                )
            item["preview"] = {
                "attributive_label": label,
                "properties": [prop.get("name") for prop in payload.get("properties") or []],
                "is_vectorized": bool(payload.get("is_vectorized")),
            }
        elif kind == "upsert_query":
            _reject_authored_escape(payload)
            if not str(payload.get("name") or "").strip():
                raise ValueError("name is required")
            query_kind = str(payload.get("kind") or "operation").strip().lower()
            if query_kind not in ("operation", "sequence"):
                raise ValueError("kind must be operation or sequence")
            payload["kind"] = query_kind
            if query_kind == "sequence":
                if not str(payload.get("entry_step") or "").strip():
                    raise ValueError("entry_step is required")
                traversal = str(payload.get("traversal") or "downstream").strip().lower()
                if traversal not in ("downstream", "single"):
                    raise ValueError("traversal must be downstream or single")
                conflict = spaces.sequence_name_conflict(
                    space_id, str(payload.get("name") or ""), exclude_id=str(payload.get("id") or "")
                )
                if conflict:
                    raise ValueError(f"A sequence named {conflict!r} already exists in this space")
            else:
                operation = str(payload.get("operation") or "").strip().lower()
                node_label = str(payload.get("node_label") or "").strip().upper()
                if operation not in _OPERATIONS:
                    raise ValueError("operation must be create, read, update, or delete")
                if node_label not in _NODE_LABELS:
                    raise ValueError("node_label must be STEP, SCHEMA, or INSTANCE")
                payload["operation"] = operation
                payload["node_label"] = node_label
                chosen = [name for name in _STEP_KINDS if payload.get(name)]
                if len(chosen) > 1:
                    raise ValueError(f"{', '.join(chosen)} are mutually exclusive")
        elif kind == "create_transition":
            if not str(payload.get("from_step") or "").strip() or not str(payload.get("to_step") or "").strip():
                raise ValueError("from_step and to_step are required")
            condition_type = str(payload.get("condition_type") or "null").strip().lower()
            if condition_type not in _CONDITION_TYPES:
                raise ValueError("condition_type must be null, parameter, cypher, implicit, or query")
            payload["condition_type"] = condition_type
        elif kind == "update_space":
            name = str(payload.get("name") or "").strip()
            if not name:
                raise ValueError("name is required")
            spaces.validate_space_name_input(name)
        elif kind == "upsert_credential":
            if "value" in payload or "secret" in payload or "api_key" in payload:
                raise ValueError("do not send the secret. The user types it on the proposal.")
            if not str(payload.get("name") or "").strip():
                raise ValueError("credential name is required")
        elif kind == "update_chat_model":
            if payload.get("api_key"):
                raise ValueError("do not send an API key. Name a credential that already exists.")
            provider = str(payload.get("provider") or "").strip()
            if provider and provider not in chat_store.CHAT_PROVIDERS:
                raise ValueError("provider must be platform, anthropic, openai, gemini, or local_llm")
            if provider in _CHAT_KEY_PROVIDERS:
                credential_name = str(payload.get("credential_name") or "").strip()
                if credential_name not in _credential_names(space_id):
                    raise ValueError(
                        "name an existing credential. Open the credentials tab to add a key first."
                    )
        elif kind == "update_embeddings":
            if "enabled" not in payload:
                raise ValueError("enabled is required")
        elif kind == "reindex_embeddings":
            pass
        elif kind == "invite_member":
            if not str(payload.get("email") or "").strip():
                raise ValueError("email is required")
            if payload.get("role") or payload.get("role_id"):
                payload["role_id"] = _role_id(space_id, payload.get("role") or payload.get("role_id"))
        elif kind == "update_member":
            if not str(payload.get("member_id") or "").strip():
                raise ValueError("member_id is required")
            if payload.get("role") or payload.get("role_id"):
                payload["role_id"] = _role_id(space_id, payload.get("role") or payload.get("role_id"))
        elif kind == "update_role":
            if not str(payload.get("name") or "").strip():
                raise ValueError("role name is required")
            if not isinstance(payload.get("permissions"), dict):
                raise ValueError("permissions must be an object")
        elif kind == "create_agent_key":
            if not str(payload.get("name") or "").strip():
                raise ValueError("name is required")
            if payload.get("role") or payload.get("role_id"):
                payload["role_id"] = _role_id(space_id, payload.get("role") or payload.get("role_id"))
        elif kind == "revoke_agent_key":
            if not str(payload.get("id") or "").strip():
                raise ValueError("id is required")
        elif kind == "update_tab_chrome":
            if not isinstance(payload.get("icon_label"), str):
                raise ValueError("icon_label is required")
        elif kind == "execute_package":
            raise ValueError("describe an operation with execute instead of execute_package")
        elif kind == "upsert_event":
            if not str(payload.get("name") or "").strip():
                raise ValueError("event name is required")
            event_type = str(payload.get("type") or "time").strip().lower()
            if event_type not in ("time", "external", "simulated"):
                raise ValueError("type must be time, external, or simulated")
            if payload.get("event_package") is not None and not isinstance(payload.get("event_package"), dict):
                raise ValueError("event_package must be an object")
        elif kind == "delete_event":
            event = catalog.get_event(str(payload.get("id") or ""))
            if event is None or str(event.get("space_id") or "") != space_id:
                raise ValueError("event was not found in this space")
            item["preview"] = {"id": event["id"], "name": event.get("name")}
        elif kind == "upsert_console":
            if not str(payload.get("name") or "").strip():
                raise ValueError("console name is required")
            kind_name = str(payload.get("trigger_kind") or "").strip().lower()
            if kind_name not in ("", "url", "event"):
                raise ValueError("trigger_kind must be url or event")
            existing_id = str(payload.get("id") or "").strip()
            existing = catalog.get_console(existing_id) if existing_id else None
            if existing is not None and str(existing.get("space_id") or "") != space_id:
                raise ValueError("console belongs to another space")
            document = payload.get("document")
            if document is not None and not isinstance(document, dict):
                raise ValueError("document must be an object")
            if isinstance(document, dict):
                document = catalog._normalize_console_document(document)
                payload["document"] = document
            if isinstance(document, dict) and _console_document_has_modules(document):
                report = console_check.check_document(
                    space_id,
                    document,
                    principal=principal,
                    console_id=existing_id or "check",
                    defer_missing=True,
                )
                item["module_check"] = report
                if not report["ok"]:
                    raise ValueError(str(report.get("summary") or "console modules would not show the expected data"))
        elif kind == "delete_console":
            console = catalog.get_console(str(payload.get("id") or ""))
            if console is None or str(console.get("space_id") or "") != space_id:
                raise ValueError("console was not found in this space")
            item["preview"] = {"id": console["id"], "name": console.get("name")}
        elif kind == "delete_sequence":
            package = catalog.fetch_query_for_compose(str(payload.get("id") or ""))
            if package is None or str(package.get("kind") or "") != "sequence":
                raise ValueError("sequence was not found")
            item["preview"] = {
                "id": package.get("id"),
                "name": package.get("name"),
                "note": "Removes the sequence from the catalog. STEP nodes stay in the graph.",
            }
        elif kind == "delete_operation":
            item["preview"] = operation_delete.preview_operation_deletion(
                space_id, operation_id=str(payload.get("id") or "")
            )
        elif kind == "delete_step":
            label = str(payload.get("attributive_label") or "").strip()
            if not label:
                raise ValueError("attributive_label is required")
            item["preview"] = step_delete.preview_step_deletion(space_id, label)
        elif kind == "delete_schema":
            label = str(payload.get("attributive_label") or "").strip()
            if not label:
                raise ValueError("attributive_label is required")
            item["preview"] = schema_delete.preview_schema_deletion(space_id, label)
    except (HTTPException, ValueError, RuntimeError, KeyError) as exc:
        errors.append(_error_text(exc))
    return errors


def validate_batch(
    principal: Principal,
    space_id: str,
    items: list[dict[str, Any]],
) -> list[str]:
    errors: list[str] = []
    seen_spaces: set[str] = set()
    for index, item in enumerate(items):
        for problem in validate_item(principal, space_id, item):
            errors.append(f"Item {index + 1} ({item.get('kind')}): {problem}")
        if item.get("kind") == "create_space":
            normalized = spaces.normalize_space_name(str(item["payload"].get("name") or ""))
            if normalized in seen_spaces:
                errors.append(f"Item {index + 1}: duplicate space name {normalized!r} in this batch")
            seen_spaces.add(normalized)
    errors.extend(
        problem for problem in input_inventory_problems(items) if input_problem_blocks_accept(problem)
    )
    return errors


def _ordered(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rank = {kind: index for index, kind in enumerate(APPLY_ORDER)}
    return sorted(items, key=lambda item: rank.get(item.get("kind"), len(rank)))


def _apply_one(
    principal: Principal,
    space_id: str,
    item: dict[str, Any],
) -> dict[str, Any]:
    kind = item["kind"]
    payload = item["payload"]
    if kind == "create_space":
        created = spaces.create_space(
            str(payload.get("name") or ""),
            (str(payload.get("endpoint")).strip() or None) if payload.get("endpoint") else None,
            description=str(payload.get("description") or ""),
        )
        new_id = str(created.get("id") or "")
        if new_id:
            roles = rbac.seed_default_roles(new_id)
            auth.add_space_member(
                new_id,
                principal.user_id,
                is_owner=True,
                role_id=roles.get(rbac.ADMIN_ROLE_NAME),
            )
        return {"id": new_id}
    if kind in AUTHORING_KINDS:
        raise ValueError(f"{kind} is saved from the builder when the user accepts")
    if kind == "update_space":
        current = spaces.fetch_space_record(space_id)
        endpoint = payload.get("endpoint") if "endpoint" in payload else current.get("endpoint")
        updated = spaces.update_space(
            space_id,
            str(payload.get("name") or current.get("name") or ""),
            (str(endpoint).strip() or None) if endpoint else None,
            description=str(payload.get("description") or "") if "description" in payload else None,
            set_description="description" in payload,
            dev_mode=bool(payload.get("dev_mode")) if "dev_mode" in payload else None,
            set_dev_mode="dev_mode" in payload,
        )
        return {"id": str(updated.get("id") or space_id)}
    if kind == "upsert_credential":
        saved = credentials.upsert_credential(
            space_id,
            str(payload.get("name") or ""),
            value=str(payload.get("value") or "") or None,
            description=str(payload.get("description") or "") or None,
        )
        return {"id": str(saved.get("id") or saved.get("name") or "")}
    if kind == "update_chat_model":
        body = {
            key: payload[key]
            for key in (
                "provider",
                "model",
                "credential_name",
                "local_llm_base_url",
                "local_llm_config_id",
                "max_rounds",
                "role",
            )
            if key in payload
        }
        saved = chat_store.set_chat_model(space_id, body)
        return {"id": str(saved.get("provider") or "")}
    if kind == "update_embeddings":
        saved = embeddings.apply_space_config(
            space_id,
            enabled=bool(payload.get("enabled")),
            provider=str(payload.get("provider")).strip() if payload.get("provider") is not None else None,
            ollama_url=str(payload.get("ollama_url")).strip() if payload.get("ollama_url") is not None else None,
            base_url=str(payload.get("base_url")).strip() if payload.get("base_url") is not None else None,
            embed_model=str(payload.get("embed_model")).strip() if payload.get("embed_model") is not None else None,
            credential=str(payload.get("credential")).strip() if payload.get("credential") is not None else None,
        )
        return {"id": str(saved.get("provider") or "")}
    if kind == "reindex_embeddings":
        saved = embeddings.reindex_space(space_id)
        return {"id": space_id, "embedded": saved.get("embedded")}
    if kind == "invite_member":
        saved = rbac.invite_member(
            space_id,
            str(payload.get("email") or ""),
            role_id=str(payload.get("role_id") or "") or None,
        )
        return {"id": str(saved.get("id") or "")}
    if kind == "update_member":
        saved = rbac.update_member(
            space_id,
            str(payload.get("member_id") or ""),
            role_id=str(payload.get("role_id") or "") or None if payload.get("role_id") else None,
            is_owner=bool(payload.get("is_owner")) if "is_owner" in payload else None,
        )
        return {"id": str(saved.get("id") or payload.get("member_id") or "")}
    if kind == "update_role":
        saved = rbac.upsert_role(
            space_id,
            str(payload.get("name") or ""),
            payload.get("permissions") if isinstance(payload.get("permissions"), dict) else {},
            role_id=str(payload.get("id") or "") or None,
        )
        return {"id": str(saved.get("id") or "")}
    if kind == "create_agent_key":
        saved = agent_keys.mint_key(
            space_id,
            str(payload.get("name") or ""),
            role_id=str(payload.get("role_id") or "") or None,
        )
        return {"id": str(saved.get("id") or ""), "token": saved.get("token")}
    if kind == "revoke_agent_key":
        saved = agent_keys.revoke_key(space_id, str(payload.get("id") or ""))
        return {"id": str(saved.get("id") or payload.get("id") or "")}
    if kind == "update_tab_chrome":
        branding.set_icon_label(str(payload.get("icon_label") or ""))
        return {"id": "tab-chrome"}
    if kind == "upsert_event":
        saved = catalog.upsert_event(
            str(payload.get("id") or ""),
            space_id,
            str(payload.get("name") or ""),
            payload.get("event_package") if isinstance(payload.get("event_package"), dict) else {},
            payload.get("sequences") if isinstance(payload.get("sequences"), list) else [],
            payload.get("recovery_sequences") if isinstance(payload.get("recovery_sequences"), list) else [],
            type=str(payload.get("type") or "time"),
            enabled=1 if payload.get("enabled", 1) else 0,
            external_package=payload.get("external_package")
            if isinstance(payload.get("external_package"), dict)
            else None,
            simulation_package=payload.get("simulation_package")
            if isinstance(payload.get("simulation_package"), dict)
            else None,
        )
        return {"id": saved.get("id")}
    if kind == "delete_event":
        return catalog.delete_event(str(payload.get("id") or ""))
    if kind == "upsert_console":
        _normalize_console_trigger(payload)
        document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
        document = catalog._normalize_console_document(document)
        document = console_service.link_console_document(document)
        saved = catalog.upsert_console(
            str(payload.get("id") or ""),
            space_id,
            str(payload.get("name") or ""),
            trigger_kind=str(payload.get("trigger_kind") or ""),
            listen_url=str(payload.get("listen_url") or ""),
            trigger_event_id=str(payload.get("trigger_event_id") or ""),
            document=document,
        )
        return {"id": saved.get("id")}
    if kind == "delete_console":
        return catalog.delete_console(str(payload.get("id") or ""))
    if kind == "delete_sequence":
        return catalog.delete_sequence(str(payload.get("id") or ""))
    if kind == "delete_operation":
        return operation_delete.execute_operation_deletion(
            space_id, operation_id=str(payload.get("id") or ""), confirm=True
        )
    if kind == "delete_step":
        return step_delete.execute_step_deletion(
            space_id, str(payload.get("attributive_label") or ""), confirm=True
        )
    if kind == "delete_schema":
        return schema_delete.execute_schema_deletion(
            space_id, str(payload.get("attributive_label") or ""), confirm=True
        )
    raise ValueError(f"Unknown change kind {kind!r}")


def _brief(item: dict[str, Any]) -> dict[str, Any]:
    return {"kind": item.get("kind"), "summary": item.get("summary")}


def _phase_of(kind: str) -> str:
    if kind in SETTINGS_KINDS:
        return "settings"
    if kind in AUTHORING_KINDS:
        return "authoring"
    return "rest"


def _inject_secret(item: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
    if item.get("kind") != "upsert_credential":
        return item
    name = str(item["payload"].get("name") or "").strip()
    value = secrets.get(name, "")
    if not value:
        return item
    payload = dict(item["payload"])
    payload["value"] = value
    return {**item, "payload": payload}


def apply_batch(
    principal: Principal,
    space_id: str,
    items: list[dict[str, Any]],
    *,
    phase: str = "complete",
    authoring_applied: list[dict[str, Any]] | None = None,
    authoring_failed: dict[str, Any] | None = None,
    credential_secrets: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Validate, then apply one phase.

    ``settings`` writes space settings and leaves builder items for the browser.
    ``rest`` writes events, consoles, reindex, and deletes after the browser reports
    what it saved. ``complete`` runs settings and then rest when the batch has no
    builder items. A batch that still has builder items stops after settings.
    """
    secrets = credential_secrets or {}
    if phase == "rest":
        rest = _ordered([item for item in items if _phase_of(str(item.get("kind") or "")) == "rest"])
        applied = [dict(entry) for entry in (authoring_applied or [])]
        if authoring_failed:
            return _finish(
                principal,
                space_id,
                items,
                applied=applied,
                failed=authoring_failed,
                not_applied=[_brief(item) for item in rest],
                created_space_id=None,
                phase="rest",
                finished=True,
            )
        return _walk(
            principal,
            space_id,
            items,
            rest,
            applied=applied,
            secrets=secrets,
            phase="rest",
            finished=True,
        )

    errors = validate_batch(principal, space_id, items)
    if errors:
        return {
            "ok": False,
            "phase": "settings",
            "finished": False,
            "validation_errors": errors,
            "applied": [],
            "failed": None,
            "not_applied": [_brief(item) for item in items],
            "authoring_pending": [],
            "created_space_id": None,
            "inputs": collect_inputs(items),
        }
    settings = _ordered([item for item in items if _phase_of(str(item.get("kind") or "")) == "settings"])
    authoring = _ordered([item for item in items if _phase_of(str(item.get("kind") or "")) == "authoring"])
    rest = _ordered([item for item in items if _phase_of(str(item.get("kind") or "")) == "rest"])
    walked = _walk(
        principal,
        space_id,
        items,
        settings,
        applied=[],
        secrets=secrets,
        phase="settings",
        finished=not authoring and not rest,
    )
    if not walked["ok"]:
        pending = [_brief(item) for item in authoring + rest]
        walked["not_applied"] = list(walked["not_applied"]) + pending
        walked["finished"] = True
        return walked
    walked["authoring_pending"] = [_brief(item) | {"payload": item.get("payload")} for item in authoring]
    if phase == "settings" or authoring or not rest:
        walked["finished"] = not authoring and not rest
        if not walked["finished"]:
            walked["phase"] = "settings"
        return walked
    rest_walk = _walk(
        principal,
        space_id,
        items,
        rest,
        applied=list(walked["applied"]),
        secrets=secrets,
        phase="complete",
        finished=True,
        created_space_id=walked.get("created_space_id"),
    )
    return rest_walk


def _finish(
    principal: Principal,
    space_id: str,
    items: list[dict[str, Any]],
    *,
    applied: list[dict[str, Any]],
    failed: dict[str, Any] | None,
    not_applied: list[dict[str, Any]],
    created_space_id: str | None,
    phase: str,
    finished: bool,
) -> dict[str, Any]:
    if applied and finished:
        catalog.record_audit(
            space_id,
            [],
            trigger="manual",
            principal_id=principal.user_id,
            detail={
                "source": "chat",
                "applied": [entry["kind"] for entry in applied],
                "failed": failed["kind"] if failed else None,
            },
        )
    return {
        "ok": failed is None,
        "phase": phase,
        "finished": finished,
        "validation_errors": [],
        "applied": applied,
        "failed": failed,
        "not_applied": not_applied,
        "authoring_pending": [],
        "created_space_id": created_space_id,
        "inputs": collect_inputs(items),
    }


def _walk(
    principal: Principal,
    space_id: str,
    items: list[dict[str, Any]],
    ordered: list[dict[str, Any]],
    *,
    applied: list[dict[str, Any]],
    secrets: dict[str, str],
    phase: str,
    finished: bool,
    created_space_id: str | None = None,
    pending_not_applied: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    failed: dict[str, Any] | None = None
    not_applied: list[dict[str, Any]] = []
    for index, item in enumerate(ordered):
        try:
            result = _apply_one(principal, space_id, _inject_secret(item, secrets))
        except Exception as exc:
            failed = {
                "kind": item.get("kind"),
                "summary": item.get("summary"),
                "error": _error_text(exc)[:500],
            }
            not_applied = [_brief(pending) for pending in ordered[index + 1 :]]
            finished = True
            break
        entry = {
            "kind": item.get("kind"),
            "summary": item.get("summary"),
            "id": result.get("id") if isinstance(result, dict) else None,
        }
        if isinstance(result, dict) and result.get("token"):
            entry["token"] = result["token"]
        applied.append(entry)
        if item.get("kind") == "create_space" and isinstance(result, dict) and result.get("id"):
            created_space_id = str(result["id"])
        if item.get("kind") == "update_space" and isinstance(result, dict) and result.get("id"):
            if str(result["id"]) != space_id:
                created_space_id = str(result["id"])
    if pending_not_applied and failed is None:
        not_applied = pending_not_applied
    return _finish(
        principal,
        space_id,
        items,
        applied=applied,
        failed=failed,
        not_applied=not_applied,
        created_space_id=created_space_id,
        phase=phase,
        finished=finished,
    )
