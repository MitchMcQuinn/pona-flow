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
    auth,
    catalog,
    console_check,
    console_service,
    cypher_utils,
    graph,
    id_generator,
    operation_delete,
    operation_nav,
    packages,
    rbac,
    schema_delete,
    schema_update,
    spaces,
    step_delete,
)
from .auth import Principal
from .http_utils import infer_node_label

APPLY_ORDER = (
    "create_space",
    "upsert_schema",
    "upsert_query",
    "execute_package",
    "upsert_event",
    "upsert_console",
    "delete_schema",
    "delete_step",
    "delete_operation",
    "delete_sequence",
    "delete_event",
    "delete_console",
)

KIND_HELP = """
Kinds and payloads:
- create_space: {name, description?, endpoint?}
- upsert_schema: {attributive_label, properties?: [{key, value_type, is_required?, is_key?, is_label?, is_indexed?, is_embedded?, format?, options?, default_value?}], is_vectorized?}
- upsert_query: {id?, name, kind: operation|sequence, operation: create|read|update|delete, cypher: [string], sqlite?: [string], parameters?: [], description?, builder_config?, loop_config?, group_title?}. kind operation is filed in the sequences nav as a one-step sequence. kind sequence must MATCH a STEP by attributive_label. cypher is one visual-builder statement: MATCH (var:INSTANCE|SCHEMA|STEP { attributive_label: 'name' }), optional WHERE, then RETURN, SET, or DELETE. CREATE or MERGE for a new node. Hops are directed. No WITH, UNION, CALL, or a custom label such as :Person.
- execute_package: {operation: create|read|update|delete, cypher: [string], sqlite?: [string], cypher_params?: {}, parameters?: [], node_label?}
- upsert_event: {id?, name, type: time|external|simulated, event_package?: {timezone, combinator?, groups: [{is_time: "18:00", is_weekday?: [1-7], is_month?, is_date?}]}, sequences?: [id], recovery_sequences?: [id], enabled?: 1, external_package?: {filters, param_mappings, combinator}}. Weekday 1 is Monday. Put the schedule in groups. A note that says 6pm does not set the time field.
- delete_event: {id}
- upsert_console: {id?, name, trigger_kind?: ""|url|event, listen_url?, trigger_event_id?, document?: {views, activeViewId}}. views is an array of {id, name, kind: live|form, modules}. A form module puts its fields in config.fields.
- delete_console: {id}
- delete_sequence: {id} removes the catalog sequence only
- delete_operation: {id} deletes the operation, its wrap step, and one-step sequences; suspends multi-step sequences
- delete_step: {attributive_label}
- delete_schema: {attributive_label}
""".strip()


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


def _schema_properties(raw: Any) -> list[dict[str, Any]]:
    """Property contract for a new SCHEMA, with the built-in id key when none is marked."""
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


def _string_list(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be an array of strings")
    return [item for item in value if item.strip()]


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
            label = str(payload.get("attributive_label") or "").strip()
            if not label:
                raise ValueError("attributive_label is required")
            holders = graph.attributive_label_owner_ids(space_id, label)
            if holders:
                raise ValueError(
                    f"attributive_label {label!r} is already used by another STEP or SCHEMA"
                )
            item["preview"] = {
                "attributive_label": label,
                "properties": [prop.get("name") for prop in payload.get("properties") or []],
                "is_vectorized": bool(payload.get("is_vectorized")),
            }
        elif kind == "upsert_query":
            if not str(payload.get("name") or "").strip():
                raise ValueError("name is required")
            cypher = _string_list(payload.get("cypher") or [], "cypher")
            if payload.get("sqlite") is not None:
                _string_list(payload.get("sqlite"), "sqlite")
            query_kind = str(payload.get("kind") or "operation").strip().lower()
            if query_kind not in ("operation", "sequence"):
                raise ValueError("kind must be operation or sequence")
            problem = cypher_utils.builder_query_problem(cypher, kind=query_kind)
            if problem:
                raise ValueError(problem)
            if query_kind == "sequence":
                conflict = spaces.sequence_name_conflict(
                    space_id, str(payload.get("name") or ""), exclude_id=str(payload.get("id") or "")
                )
                if conflict:
                    raise ValueError(f"A sequence named {conflict!r} already exists in this space")
        elif kind == "execute_package":
            operation = str(payload.get("operation") or "create").strip().lower()
            if operation not in ("create", "read", "update", "delete"):
                raise ValueError("operation must be create, read, update, or delete")
            _string_list(payload.get("cypher") or [], "cypher")
            if payload.get("sqlite") is not None:
                _string_list(payload.get("sqlite"), "sqlite")
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
    return errors


def _ordered(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rank = {kind: index for index, kind in enumerate(APPLY_ORDER)}
    return sorted(items, key=lambda item: rank.get(item.get("kind"), len(rank)))


def _apply_schema(space_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Materialize a SCHEMA node, its entities-table contract, and any property indexes."""
    label = str(payload.get("attributive_label") or "").strip()
    properties = payload.get("properties") if isinstance(payload.get("properties"), list) else []
    holders = graph.attributive_label_owner_ids(space_id, label)
    if holders:
        raise ValueError(f"attributive_label {label!r} is already used by another STEP or SCHEMA")
    schema_id = id_generator.generate_id()
    graph.run_cypher_for_space(
        space_id,
        "CREATE (n:SCHEMA {id: $id, attributive_label: $attributive_label})",
        {"id": schema_id, "attributive_label": label},
    )
    body: dict[str, Any] = {"schemata": [{"property_schema": prop} for prop in properties]}
    if payload.get("is_vectorized"):
        body["is_vectorized"] = True
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        conn.execute(
            "INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) "
            "VALUES (?, 'SCHEMA', ?, '[]', ?, datetime('now'), datetime('now'))",
            (schema_id, label, json.dumps(body)),
        )
        conn.commit()
    finally:
        conn.close()
    spaces.append_space_attributive_labels(space_id, [label])
    schema_update._apply_index_changes(
        space_id,
        label,
        {},
        {str(prop.get("name") or ""): prop for prop in properties},
        False,
    )
    return {"id": schema_id, "attributive_label": label}


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
    if kind == "upsert_schema":
        return _apply_schema(space_id, payload)
    if kind == "upsert_query":
        builder = payload.get("builder_config")
        loop = payload.get("loop_config")
        result = catalog.upsert_queries_catalog_row(
            str(payload.get("id") or ""),
            str(payload.get("name") or ""),
            _string_list(payload.get("cypher") or [], "cypher"),
            _string_list(payload.get("sqlite") or [], "sqlite"),
            payload.get("parameters") if isinstance(payload.get("parameters"), list) else [],
            kind=str(payload.get("kind") or "operation"),
            operation=str(payload.get("operation") or "read"),
            runtime_enabled=1 if payload.get("runtime_enabled", True) else 0,
            author_selectable=1,
            group_title=(str(payload.get("group_title") or "").strip() or None),
            triggerable=1 if payload.get("triggerable", True) else 0,
            builder_config=json.dumps(builder) if isinstance(builder, (dict, list)) else None,
            description=str(payload.get("description") or ""),
            loop_config=json.dumps(loop) if isinstance(loop, (dict, list)) else None,
        )
        group = str(payload.get("group_title") or "").strip()
        if group:
            spaces.append_space_group(space_id, group)
        saved_id = str(result.get("id") or payload.get("id") or "")
        query_kind = str(payload.get("kind") or "operation").strip().lower()
        if query_kind == "sequence":
            operation_nav.register_sequence_labels(
                space_id, _string_list(payload.get("cypher") or [], "cypher")
            )
        else:
            operation_nav.publish_operation_sequence(space_id, saved_id)
        return {"id": saved_id}
    if kind == "execute_package":
        operation = str(payload.get("operation") or "create").strip().lower()
        cypher = _string_list(payload.get("cypher") or [], "cypher")
        sqlite_stmts = _string_list(payload.get("sqlite") or [], "sqlite")
        params = payload.get("cypher_params") if isinstance(payload.get("cypher_params"), dict) else {}
        if operation == "create":
            packages.execute_create_package(
                space_id,
                cypher,
                sqlite_stmts,
                params,
                queries_catalog=payload.get("queries_catalog")
                if isinstance(payload.get("queries_catalog"), dict)
                else None,
                attributive_labels=payload.get("attributive_labels")
                if isinstance(payload.get("attributive_labels"), list)
                else None,
            )
        else:
            packages.execute_mutation_package(
                space_id,
                cypher,
                sqlite_stmts,
                params,
                operation=operation,
                declared=payload.get("parameters") if isinstance(payload.get("parameters"), list) else None,
            )
        return {"operation": operation}
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


def apply_batch(
    principal: Principal,
    space_id: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Validate every item, then apply. Validation failure writes nothing."""
    errors = validate_batch(principal, space_id, items)
    if errors:
        return {
            "ok": False,
            "validation_errors": errors,
            "applied": [],
            "failed": None,
            "not_applied": [
                {"kind": item.get("kind"), "summary": item.get("summary")} for item in items
            ],
            "created_space_id": None,
        }
    ordered = _ordered(items)
    applied: list[dict[str, Any]] = []
    failed: dict[str, Any] | None = None
    not_applied: list[dict[str, Any]] = []
    created_space_id: str | None = None
    for index, item in enumerate(ordered):
        try:
            result = _apply_one(principal, space_id, item)
        except Exception as exc:
            failed = {
                "kind": item.get("kind"),
                "summary": item.get("summary"),
                "error": _error_text(exc)[:500],
            }
            not_applied = [
                {"kind": pending.get("kind"), "summary": pending.get("summary")}
                for pending in ordered[index + 1 :]
            ]
            break
        entry = {
            "kind": item.get("kind"),
            "summary": item.get("summary"),
            "id": result.get("id") if isinstance(result, dict) else None,
        }
        applied.append(entry)
        if item.get("kind") == "create_space" and isinstance(result, dict) and result.get("id"):
            created_space_id = str(result["id"])
    if applied:
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
        "validation_errors": [],
        "applied": applied,
        "failed": failed,
        "not_applied": not_applied,
        "created_space_id": created_space_id,
    }
