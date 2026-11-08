"""Requirements for every field a chat proposal can set.

``propose_change`` runs this before the item is queued. Each problem names the
field and the requirement, so a plan is not shown with a value the builder or
the catalog would reject when the user accepts it.
"""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from typing import Any, Callable, Iterator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import cypher_utils, id_generator, rbac, triggers

MAX_WAIT_SECONDS = 30 * 24 * 3600
MAX_TIMEOUT_SECONDS = 300
MAX_ATTEMPTS = 20
MAX_VECTOR_K = 100
MIN_ROUNDS = 4
MAX_ROUNDS = 48
MAX_ICON_LABEL = 8
MAX_FIELD_DEPTH = 8
_PROBLEM_CAP = 40

_PARAM = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_LABEL = re.compile(r"^[a-z][a-z0-9_]*$")
_DOLLAR = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]*$")
_URL = re.compile(r"^https?://\S+$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TIME = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")
_ROW_FIELD = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$")
_SECRET_REF = re.compile(r"^\$secret(?:\.|$)", re.IGNORECASE)

_SCHEMA_TYPES = (
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "UID",
    "radio",
    "checkbox",
)
_PARAM_TYPES = _SCHEMA_TYPES + ("attributive label",)
_SEED_FORMATS = ("any", "email", "phone", "point", "URL", "ZIP", "color")
_FLOWS = rbac.ALL_FLOWS
_RESERVED_VECTOR = frozenset(
    {"vector_query_text", "vector_k", "vector_query", "vector_index", "vector_overfetch"}
)
_HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
_WHERE_OPS = ("=", "<>", ">", ">=", "<", "<=", "CONTAINS", "STARTS WITH", "ENDS WITH", "IS NULL", "IS NOT NULL")
_VALUELESS_WHERE = frozenset({"IS NULL", "IS NOT NULL"})
_STEP_OPS = (
    "=",
    "<>",
    "<",
    "<=",
    ">",
    ">=",
    "CONTAINS",
    "STARTS WITH",
    "ENDS WITH",
    "EXISTS",
    "IS EMPTY",
    "REGEX",
)
_UNARY_OPS = frozenset({"EXISTS", "IS EMPTY"})
_COLLISIONS = ("overwrite", "skip", "append", "sequence")
_JUNCTIONS = ("AND", "OR")
_LOOP_TYPES = ("dag", "for", "for_while", "for_each")
_LOOP_OPS = ("=", "<>", "<", "<=", ">", ">=", "CONTAINS", "STARTS WITH", "ENDS WITH")
_REDUCE = ("list", "count")
_FILTER_OPS = ("equals", "contains", "exists", "regex")
_MODULE_TYPES = (
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
)
_DISPLAY = frozenset(_MODULE_TYPES[:12])
_ACTION = frozenset(_MODULE_TYPES[12:])
_FORM_FIELD_TYPES = ("text", "textarea", "number", "checkbox", "radio", "select", "array")
_CHOICE_FIELDS = frozenset({"select", "checkbox", "radio"})
_CHART_COLORS = ("accent.4", "violet.5", "pink.5", "cyan.4", "teal.4", "red.4")
_BUTTON_COLORS = ("accent", "cyan", "violet", "red", "gray")
_ALERT_COLORS = ("yellow", "cyan", "red", "violet", "gray")
_STEP_KEYS = ("http_step", "wait_step", "join_step", "operation_step")
_ESCAPE = frozenset({"cypher", "sqlite", "builder_config", "query"})
_LABEL_KEYS = {
    "upsert_schema": ("attributive_label",),
    "upsert_query": ("attributive_label", "entry_step"),
    "create_transition": ("from_step", "to_step", "relationship_label"),
    "delete_step": ("attributive_label",),
    "delete_schema": ("attributive_label",),
}

Check = Callable[[Any, str, list[str]], None]


def _fail(problems: list[str], path: str, text: str) -> None:
    if len(problems) >= _PROBLEM_CAP:
        return
    problems.append(f"{path} {text}")


def _enum(values: tuple[str, ...] | list[str], *, required: bool = False, sample: str | None = None) -> dict[str, Any]:
    listed = ", ".join(str(item) for item in values)
    return {
        "type": "string",
        "requirement": f"must be one of {listed}.",
        "required": required,
        "enum": tuple(values),
        "invalid": "nope",
        "sample": values[0] if sample is None else sample,
    }


def _str(requirement: str = "must be a string.", *, required: bool = False, pattern: re.Pattern[str] | None = None, invalid: Any = None) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "type": "string",
        "requirement": requirement,
        "required": required,
        "invalid": "" if required and invalid is None else (1 if invalid is None else invalid),
    }
    if pattern is not None:
        spec["pattern"] = pattern
        if not required and invalid is None:
            spec["invalid"] = "!!!"
    return spec


def _bool(requirement: str = "must be true or false.", *, required: bool = False) -> dict[str, Any]:
    return {"type": "bool", "requirement": requirement, "required": required, "invalid": "yes"}


def _int(requirement: str, *, required: bool = False, minimum: int | None = None, maximum: int | None = None, invalid: Any = "x") -> dict[str, Any]:
    spec: dict[str, Any] = {
        "type": "int",
        "requirement": requirement,
        "required": required,
        "invalid": invalid,
    }
    if minimum is not None:
        spec["min"] = minimum
    if maximum is not None:
        spec["max"] = maximum
    return spec


def _obj(requirement: str, fields: dict[str, dict[str, Any]], *, required: bool = False, allow_unknown: bool = False, check: Check | None = None, recursive: bool = False) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "type": "object",
        "requirement": requirement,
        "required": required,
        "fields": fields,
        "allow_unknown": allow_unknown,
        "invalid": "nope",
    }
    if check is not None:
        spec["check"] = check
    if recursive:
        spec["recursive"] = True
    return spec


def _arr(requirement: str, items: dict[str, Any], *, required: bool = False, minimum: int | None = None, check: Check | None = None) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "type": "array",
        "requirement": requirement,
        "required": required,
        "items": items,
        "invalid": "nope",
    }
    if minimum is not None:
        spec["min_items"] = minimum
    if check is not None:
        spec["check"] = check
    return spec


def _root(requirement: str, fields: dict[str, dict[str, Any]], *, check: Check | None = None) -> dict[str, Any]:
    spec = _obj(requirement, fields, check=check)
    spec.pop("invalid", None)
    return spec


def _labeled(requirement: str, *, required: bool = False) -> dict[str, Any]:
    return _str(requirement, required=required, pattern=_LABEL, invalid="!!!")


def _url(requirement: str = "must be an absolute http or https URL.") -> dict[str, Any]:
    spec = _str(requirement, invalid="localhost")
    spec["check"] = _check_url
    return spec


def _check_url(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str) or not value.strip():
        return
    if _URL.fullmatch(value.strip()) is None:
        _fail(problems, path, "must be an absolute http or https URL.")


def _canon(value: Any, options: tuple[str, ...] | list[str]) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text in options:
        return text
    folded = text.lower()
    for option in options:
        if option.lower() == folded:
            return option
    return value


def _align_label(payload: dict[str, Any], key: str) -> None:
    raw = payload.get(key)
    if not isinstance(raw, str) or not raw.strip():
        return
    normalized = cypher_utils.normalize_attributive_label(raw)
    if normalized:
        payload[key] = normalized


def _align_enum(payload: dict[str, Any], key: str, options: tuple[str, ...] | list[str]) -> None:
    if key in payload:
        payload[key] = _canon(payload.get(key), options)


def _known_formats() -> set[str]:
    names = set(_SEED_FORMATS)
    try:
        from . import catalog

        for row in catalog.list_regex_patterns():
            name = str(row.get("name") or "").strip()
            if name:
                names.add(name)
    except Exception:
        pass
    return names


def _format_regex(name: str) -> str | None:
    try:
        from . import catalog

        for row in catalog.list_regex_patterns():
            if str(row.get("name") or "") == name:
                return str(row.get("regex") or "")
    except Exception:
        return None
    return None


def _check_format_name(value: str, path: str, problems: list[str]) -> None:
    names = _known_formats()
    if value not in names:
        listed = ", ".join(sorted(names))
        _fail(problems, path, f"must be a format name ({listed}).")


def _check_default(prop: dict[str, Any], path: str, problems: list[str]) -> None:
    raw = str(prop.get("default_value") or "").strip()
    if not raw or raw.lower() == "null":
        return
    value_type = prop.get("value_type")
    options = [str(item).strip() for item in prop.get("options") or [] if str(item).strip()]
    if value_type == "boolean" and raw not in ("true", "false"):
        _fail(problems, path, "must be true or false.")
    elif value_type == "integer" and re.fullmatch(r"-?\d+", raw) is None:
        _fail(problems, path, "must be an integer.")
    elif value_type == "number":
        try:
            if raw.lower() in ("nan", "inf", "+inf", "-inf"):
                raise ValueError
            float(raw)
        except ValueError:
            _fail(problems, path, "must be a number.")
    elif value_type == "array":
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError:
            _fail(problems, path, "must be a JSON array.")
            return
        if not isinstance(parsed, list):
            _fail(problems, path, "must be a JSON array.")
    elif value_type == "radio" and raw not in options:
        _fail(problems, path, "must be one of the options.")
    elif value_type == "checkbox":
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError:
            _fail(problems, path, "must be a JSON array of options.")
            return
        if not isinstance(parsed, list) or any(str(item) not in options for item in parsed):
            _fail(problems, path, "must be a JSON array of the options.")
    elif value_type == "string":
        format_name = str(prop.get("format") or "").strip()
        if format_name and format_name != "any":
            regex = _format_regex(format_name)
            if regex and re.fullmatch(regex, raw) is None:
                _fail(problems, path, f"must match the {format_name} format.")


def _check_property(prop: Any, path: str, problems: list[str]) -> None:
    if not isinstance(prop, dict):
        return
    name = str(prop.get("name") or prop.get("key") or "").strip()
    if name.lower() in {"embedding", "embedding_stale"}:
        _fail(problems, path, f"{name} is reserved and cannot be defined on a SCHEMA.")
    value_type = prop.get("value_type")
    options = prop.get("options")
    if value_type in ("radio", "checkbox"):
        if not isinstance(options, list) or not any(str(item).strip() for item in options):
            _fail(problems, f"{path}.options", "is required. Radio and checkbox need at least one option.")
    elif isinstance(options, list):
        _fail(problems, f"{path}.options", "is only for radio and checkbox.")
    if value_type == "checkbox":
        low = prop.get("min_choices")
        high = prop.get("max_choices")
        if isinstance(low, int) and not isinstance(low, bool) and isinstance(high, int) and not isinstance(high, bool) and low > high:
            _fail(problems, f"{path}.min_choices", "cannot be greater than max_choices.")
    else:
        if "min_choices" in prop:
            _fail(problems, f"{path}.min_choices", "is only for checkbox.")
        if "max_choices" in prop:
            _fail(problems, f"{path}.max_choices", "is only for checkbox.")
    if "format" in prop and value_type != "string":
        _fail(problems, f"{path}.format", "is only for a string property.")
    elif isinstance(prop.get("format"), str) and prop.get("format"):
        _check_format_name(str(prop["format"]), f"{path}.format", problems)
    if isinstance(prop.get("default_value"), str):
        _check_default(prop, f"{path}.default_value", problems)


def _one_label(properties: Any, path: str, problems: list[str]) -> None:
    if not isinstance(properties, list) or not properties:
        return
    labels = [item for item in properties if isinstance(item, dict) and item.get("is_label") is True]
    if len(labels) != 1:
        _fail(problems, path, "needs exactly one property with is_label true. Put it on the name-like field.")
    names: list[str] = []
    for item in properties:
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("key") or "").strip()
            if name:
                names.append(name)
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        _fail(problems, path, f"lists {', '.join(repeated)} more than once.")


def _check_time(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    text = value.strip().lower()
    if text.endswith("z"):
        text = text[:-1].strip()
    if _TIME.fullmatch(text) is None:
        _fail(problems, path, "must be 24-hour HH:MM, for example 18:00. A note that says 6pm does not set this.")


def _check_date(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    if triggers._parse_date(value) is None:
        _fail(problems, path, "must be an ISO date, for example 2026-11-07.")


def _check_zone(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str) or not value.strip() or value.strip().upper() == "UTC":
        return
    try:
        ZoneInfo(value.strip())
    except ZoneInfoNotFoundError:
        _fail(problems, path, "must be a timezone name, for example America/New_York, or UTC.")


def _check_email(value: Any, path: str, problems: list[str]) -> None:
    if isinstance(value, str) and _EMAIL.fullmatch(value.strip() or "") is None:
        _fail(problems, path, "must be an email address.")


def _check_credential_name(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    try:
        from .credentials import validate_credential_name

        validate_credential_name(value)
    except ValueError as exc:
        _fail(problems, path, str(exc))


def _check_icon(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    if len(value) > MAX_ICON_LABEL:
        _fail(problems, path, f"must be {MAX_ICON_LABEL} characters or fewer.")
    if any(ord(ch) < 32 for ch in value):
        _fail(problems, path, "cannot include control characters.")


def _check_until(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    text = value.strip()
    if _DOLLAR.fullmatch(text):
        return
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        _fail(problems, path, "must be an ISO-8601 datetime, or exactly $name.")


def _number_or_param(value: Any, path: str, spec: dict[str, Any], problems: list[str]) -> None:
    if isinstance(value, str) and _DOLLAR.fullmatch(value.strip()):
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(problems, path, spec["requirement"])
        return
    if spec.get("integer") and not isinstance(value, int):
        _fail(problems, path, spec["requirement"])
        return
    if isinstance(value, float) and value != value:
        _fail(problems, path, spec["requirement"])
        return
    if spec.get("min") is not None and value < spec["min"]:
        _fail(problems, path, spec["requirement"])
    elif spec.get("max") is not None and value > spec["max"]:
        _fail(problems, path, spec["requirement"])


def _check_options(value: Any, path: str, problems: list[str]) -> None:
    if isinstance(value, str):
        return
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return
    _fail(problems, path, "must be a comma-separated string or an array of strings.")


def _check_scalar(value: Any, path: str, problems: list[str]) -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            _fail(problems, path, "must be a finite number, a string, or a boolean.")
        return
    if not isinstance(value, str):
        _fail(problems, path, "must be a literal or a $parameter (optionally .field).")
        return
    text = value.strip()
    if _SECRET_REF.match(text):
        _fail(problems, path, "cannot read credentials ($secret). Use a literal or a $parameter.")
        return
    if text.startswith("$") and not _operand_ok(text):
        _fail(problems, path, "must be a literal or a $parameter (optionally .field).")


def _operand_ok(value: str) -> bool:
    text = value.strip()
    if not text.startswith("$"):
        return True
    if _SECRET_REF.match(text):
        return False
    return re.fullmatch(r"\$(?!secret(?:\.|$))[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*", text, re.IGNORECASE) is not None


def _check_flow(value: Any, path: str, problems: list[str]) -> None:
    if isinstance(value, str) and value not in _FLOWS:
        _fail(problems, path, f"must be one of {', '.join(_FLOWS)}.")


def _check(spec: dict[str, Any], value: Any, path: str, problems: list[str], depth: int = 0) -> None:
    here = depth + 1 if spec.get("recursive") else depth
    if here > MAX_FIELD_DEPTH:
        _fail(problems, path, "is nested too deeply. Form fields can nest up to 8 levels.")
        return
    kind = spec["type"]
    requirement = spec.get("requirement") or "is invalid."
    if kind == "string":
        if not isinstance(value, str):
            _fail(problems, path, "must be a string.")
            return
        if spec.get("enum") is not None and value not in spec["enum"]:
            _fail(problems, path, requirement)
            return
        if spec.get("required") and not value.strip():
            _fail(problems, path, f"is required. {requirement}")
            return
        pattern = spec.get("pattern")
        if pattern is not None and value.strip() and pattern.fullmatch(value.strip()) is None:
            _fail(problems, path, requirement)
            return
    elif kind == "bool":
        if not isinstance(value, bool):
            _fail(problems, path, requirement)
            return
    elif kind == "bit":
        if value is not True and value is not False and value not in (0, 1):
            _fail(problems, path, requirement)
            return
    elif kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            _fail(problems, path, requirement)
            return
        if spec.get("min") is not None and value < spec["min"]:
            _fail(problems, path, requirement)
            return
        if spec.get("max") is not None and value > spec["max"]:
            _fail(problems, path, requirement)
            return
    elif kind == "number_or_param":
        _number_or_param(value, path, spec, problems)
    elif kind == "scalar":
        _check_scalar(value, path, problems)
    elif kind == "options":
        _check_options(value, path, problems)
    elif kind == "object":
        if not isinstance(value, dict):
            _fail(problems, path, "must be an object.")
            return
        fields = spec.get("fields") or {}
        if not spec.get("allow_unknown"):
            for key in value:
                if key not in fields:
                    _fail(problems, f"{path}.{key}", _unknown(path, key, fields, spec))
        for key, child in fields.items():
            if key not in value:
                if child.get("required"):
                    _fail(problems, f"{path}.{key}", f"is required. {child.get('requirement') or ''}".rstrip())
                continue
            _check(child, value[key], f"{path}.{key}", problems, here)
    elif kind in ("array", "field_list"):
        parsed = value
        if kind == "field_list" and isinstance(value, str):
            try:
                parsed = json.loads(value) if value.strip() else []
            except json.JSONDecodeError:
                _fail(problems, path, "must be a JSON array of fields.")
                return
        if not isinstance(parsed, list):
            _fail(problems, path, requirement if kind == "field_list" else "must be an array.")
            return
        if spec.get("min_items") and len(parsed) < spec["min_items"]:
            _fail(problems, path, requirement)
        items = spec.get("items")
        if items is not None:
            for index, item in enumerate(parsed):
                _check(items, item, f"{path}[{index}]", problems, here)
    else:
        _fail(problems, path, requirement)
        return
    check = spec.get("check")
    if check is not None and kind not in ("number_or_param", "scalar", "options"):
        check(value if kind != "field_list" else value, path, problems)


def _unknown(path: str, key: str, fields: dict[str, Any], spec: dict[str, Any]) -> str:
    if key in _ESCAPE:
        return f"is not a field. {key} is not a builder field. Describe operation, node_label, properties, or entry_step instead."
    if key == "api_key":
        return "is not a field. Do not send an API key. Name a credential that already exists."
    if key in {"value", "secret"}:
        return "is not a field. do not send the secret. The user types it on the proposal."
    alias = {
        "dataUrl": "is not a field. A module reads a sequence. Set dataSequenceId.",
        "actionUrl": "is not a field. A module runs a sequence. Set actionSequenceId.",
        "data_sequence_id": "is not a field. Use dataSequenceId.",
        "sequenceId": "is not a field. Use dataSequenceId.",
        "sequence_id": "is not a field. Use dataSequenceId.",
        "action_sequence_id": "is not a field. Use actionSequenceId.",
        "manageSpace": "is not a field. Use manage_space.",
        "triggerKind": "is not a field. Use trigger_kind.",
        "triggerEventId": "is not a field. Use trigger_event_id.",
        "listenUrl": "is not a field. Use listen_url.",
        "fields": "is not a field. Put form fields in config.fields.",
    }.get(key)
    if alias:
        return alias
    if not fields:
        return f"is not a field. {spec.get('requirement') or 'This object has no fields.'}"
    allowed = ", ".join(sorted(fields))
    return f"is not a field. Allowed fields: {allowed}."


def _check_form_field(field: Any, path: str, problems: list[str]) -> None:
    if not isinstance(field, dict):
        return
    field_type = field.get("type")
    if field_type in _CHOICE_FIELDS:
        options = field.get("options")
        if isinstance(options, str):
            usable = [part.strip() for part in options.split(",") if part.strip()]
        elif isinstance(options, list):
            usable = [str(item).strip() for item in options if str(item).strip()]
        else:
            usable = []
        if not usable:
            _fail(problems, f"{path}.options", "is required. Select, checkbox, and radio need at least one option.")
    elif "options" in field:
        _fail(problems, f"{path}.options", "is only for select, checkbox, and radio.")
    if field_type == "number":
        low = field.get("min")
        high = field.get("max")
        if isinstance(low, (int, float)) and not isinstance(low, bool) and isinstance(high, (int, float)) and not isinstance(high, bool) and low > high:
            _fail(problems, f"{path}.min", "cannot be greater than max.")
    else:
        if "min" in field:
            _fail(problems, f"{path}.min", "is only for a number field.")
        if "max" in field:
            _fail(problems, f"{path}.max", "is only for a number field.")
    if field_type != "array" and isinstance(field.get("fields"), list) and field.get("fields"):
        _fail(problems, f"{path}.fields", "is only for an array field.")


def _check_parameter(param: Any, path: str, problems: list[str]) -> None:
    if isinstance(param, dict) and param.get("name") in _RESERVED_VECTOR:
        _fail(problems, f"{path}.name", "is reserved for vector search. Do not declare it.")


def _check_where(row: Any, path: str, problems: list[str]) -> None:
    if not isinstance(row, dict):
        return
    operator = row.get("operator") or "="
    if operator not in _VALUELESS_WHERE and "value" not in row:
        _fail(problems, f"{path}.value", "is required unless the operator is IS NULL or IS NOT NULL.")


def _check_statement(row: Any, path: str, problems: list[str]) -> None:
    if not isinstance(row, dict):
        return
    operator = row.get("operator")
    if operator in _UNARY_OPS:
        return
    if "y" not in row:
        _fail(problems, f"{path}.y", "is required unless the operator is EXISTS or IS EMPTY.")


def _check_assignment(row: Any, path: str, problems: list[str]) -> None:
    if not isinstance(row, dict):
        return
    value = row.get("value")
    if isinstance(value, str) and value.strip().startswith("$"):
        _fail(problems, f"{path}.value", "must be a literal, not a $parameter.")
        return
    kind = row.get("type")
    if kind == "boolean" and not isinstance(value, bool):
        _fail(problems, f"{path}.value", "must be true or false for a boolean assignment.")
    elif kind == "string" and not isinstance(value, str):
        _fail(problems, f"{path}.value", "must be text for a string assignment.")
    elif kind == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        _fail(problems, f"{path}.value", "must be a finite number for a number assignment.")


def _duration(requirement: str, *, minimum: float = 0, maximum: float = MAX_WAIT_SECONDS, integer: bool = False, invalid: Any = None) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "type": "number_or_param",
        "requirement": requirement,
        "min": minimum,
        "max": maximum,
        "invalid": MAX_WAIT_SECONDS + 1 if invalid is None else invalid,
    }
    if integer:
        spec["integer"] = True
    return spec


_time_field = _str("must be 24-hour HH:MM, for example 18:00.", invalid="6pm")
_time_field["check"] = _check_time
_date_field = _str("must be an ISO date, for example 2026-11-07.", invalid="Tuesday")
_date_field["check"] = _check_date
_zone_field = _str("must be a timezone name, for example America/New_York, or UTC.", invalid="Mars/Base")
_zone_field["check"] = _check_zone
_email_field = _str("must be an email address.", required=True, invalid="guest")
_email_field["check"] = _check_email
_credential_field = _str("must contain letters, numbers, or underscores, and must not start with a number.", required=True, invalid="***")
_credential_field["check"] = _check_credential_name
_icon_field = _str(f"must be {MAX_ICON_LABEL} characters or fewer.", required=True, invalid="123456789")
_icon_field["check"] = _check_icon
_until_field = _str("must be an ISO-8601 datetime, or exactly $name.", invalid="tomorrow")
_until_field["check"] = _check_until
_flow_field = _str(f"must be one of {', '.join(_FLOWS)}.", invalid="read")
_flow_field["check"] = _check_flow

_property_flags = {
    "value_type": _enum(_SCHEMA_TYPES, required=True),
    "is_required": _bool(),
    "is_key": _bool(),
    "is_label": _bool(),
    "is_indexed": _bool(),
    "is_embedded": _bool(),
    "format": _str("must be a format name, or any.", invalid="not-a-format"),
    "options": _arr("must be an array of option strings.", _str("must be a string.")),
    "min_choices": _int("must be a whole number, 0 or more.", minimum=0, invalid=-1),
    "max_choices": _int("must be a whole number, 0 or more.", minimum=0, invalid=-1),
    "default_value": _str("must be text that matches the value type."),
}
_property_flags["value_type"]["invalid"] = "text"


def _property_spec(identity: str) -> dict[str, Any]:
    fields = {
        identity: _labeled("must be a lowercase property name.", required=True),
        **{key: copy.deepcopy(value) for key, value in _property_flags.items()},
    }
    return _obj("One schema property.", fields, check=_check_property)


def _properties_spec(identity: str) -> dict[str, Any]:
    spec = _arr("must be an array of properties. Exactly one has is_label true.", _property_spec(identity), check=_one_label)
    return spec


_FORM_FIELD: dict[str, Any] = {
    "type": "object",
    "recursive": True,
    "requirement": "One form field.",
    "invalid": "nope",
    "fields": {},
}
_FORM_FIELDS: dict[str, Any] = {
    "type": "field_list",
    "requirement": "must be an array of fields, or a JSON array.",
    "invalid": "not-json",
    "items": _FORM_FIELD,
}
_field_type = _enum(_FORM_FIELD_TYPES, required=True)
_field_type["invalid"] = "dropdown"
_FORM_FIELD["fields"] = {
    "id": _str("must be a string."),
    "name": _str("must be a letter or underscore, then letters, digits, or underscores.", required=True, pattern=_PARAM, invalid="1bad"),
    "label": _str("must be the label a person sees.", required=True),
    "type": _field_type,
    "required": _bool(),
    "options": {"type": "options", "requirement": "must be a comma-separated string or an array of strings.", "invalid": 1},
    "placeholder": _str("must be a string."),
    "page": _int("must be a whole number, 0 or more. Page 0 is the first submit.", minimum=0, invalid=-1),
    "min": _int("must be a whole number.", invalid="x"),
    "max": _int("must be a whole number.", invalid="x"),
    "fields": _FORM_FIELDS,
}
_FORM_FIELD["check"] = _check_form_field

_layout = _obj(
    "Grid position in columns and rows.",
    {
        "x": _int("must be a whole number.", invalid="x"),
        "y": _int("must be a whole number.", invalid="x"),
        "w": _int("must be a whole number of columns, at least 1.", minimum=1, invalid=0),
        "h": _int("must be a whole number of rows, at least 1.", minimum=1, invalid=0),
        "minW": _int("must be a whole number.", minimum=1, invalid=0),
        "minH": _int("must be a whole number.", minimum=1, invalid=0),
    },
)
_data_path = _str("must be a dot path into the result, or empty to use the whole body.")
_chart_color = _enum(_CHART_COLORS)
_chart_color["invalid"] = "blue"
_button_color = _enum(_BUTTON_COLORS)
_button_color["invalid"] = "blue"
_alert_color = _enum(_ALERT_COLORS)
_alert_color["invalid"] = "blue"
_comma = _str("must be a comma-separated string, for example day, week, month.")

CONFIG: dict[str, dict[str, dict[str, Any]]] = {
    "stat": {"dataPath": _data_path},
    "text": {"dataPath": _data_path},
    "table": {"dataPath": _data_path},
    "badge": {"dataPath": _data_path},
    "progress": {"dataPath": _data_path},
    "ring": {"dataPath": _data_path},
    "graph": {"dataPath": _data_path},
    "donut": {"dataPath": _data_path},
    "line": {"dataPath": _data_path, "categoryKey": _str("must name the label column."), "valueKey": _str("must name the numeric column."), "color": _chart_color},
    "bar": {"dataPath": _data_path, "categoryKey": _str("must name the label column."), "valueKey": _str("must name the numeric column."), "color": _chart_color},
    "area": {"dataPath": _data_path, "categoryKey": _str("must name the label column."), "valueKey": _str("must name the numeric column."), "color": _chart_color},
    "alert": {"dataPath": _data_path, "color": _alert_color},
    "button": {"dataPath": _data_path, "label": _str("must be the button label."), "color": _button_color, "payload": _str("must be the value sent when the button is pressed.")},
    "switch": {"dataPath": _data_path, "label": _str("must be the switch label.")},
    "checkbox": {"dataPath": _data_path, "label": _str("must be the checkbox label.")},
    "segmented": {"dataPath": _data_path, "options": _comma},
    "select": {"dataPath": _data_path, "label": _str("must be the select label."), "options": _comma},
    "number": {"dataPath": _data_path, "label": _str("must be the number label.")},
    "form": {"dataPath": _data_path, "autoRefresh": _bool("must be true or false."), "fields": _FORM_FIELDS},
}

_source = _enum(("sequence",))
_source["requirement"] = "must be sequence. A module reads a saved sequence, not a URL."
_module = _obj(
    "One console module.",
    {
        "id": _str("must be a string."),
        "type": _enum(_MODULE_TYPES, required=True),
        "title": _str("must be the title shown on the module."),
        "dataSource": _source,
        "dataSequenceId": _str("Set it to a sequence or read operation, by catalog id or name.", required=True),
        "actionSource": _source,
        "actionSequenceId": _str("Set it to the sequence that runs on submit, by catalog id or name."),
        "config": _obj("Module settings. The keys depend on the module type.", {}, allow_unknown=True),
        "layout": _layout,
    },
)
_module["config"] = _obj("Module settings. The keys depend on the module type.", {}, allow_unknown=True)
_module["fields"]["config"] = _module["config"]

_free = _obj("JSON object.", {}, allow_unknown=True)
_response = _obj(
    "One value copied out of the response.",
    {
        "property_path": _str("must be a dot path into the response body, for example data.id.", required=True),
        "parameter": _str("must be a parameter name.", required=True, pattern=_PARAM, invalid="1bad"),
        "default_value": _str("must be a string."),
    },
)
_http = _obj(
    "HTTP call for a custom-endpoint STEP.",
    {
        "endpoint": _str("must be an absolute http or https URL, or exactly $name.", required=True, invalid="shipments"),
        "method": _enum(_HTTP_METHODS),
        "body": _free,
        "headers": _free,
        "response_parameters": _arr("must be an array of response mappings.", _response),
        "timeout_seconds": _duration(f"must be a number of seconds from 1 to {MAX_TIMEOUT_SECONDS}, or exactly $name.", minimum=1, maximum=MAX_TIMEOUT_SECONDS, invalid=0),
        "max_attempts": _int(f"must be a whole number from 1 to {MAX_ATTEMPTS}.", minimum=1, maximum=MAX_ATTEMPTS, invalid=0),
        "backoff_seconds": _duration(f"must be a number of seconds from 0 to {MAX_WAIT_SECONDS}, or exactly $name.", invalid=-1),
    },
)
_wait = _obj(
    "Wait STEP.",
    {
        "mode": _enum(("duration", "until", "event"), required=True),
        "duration_seconds": _duration(f"must be a number of seconds from 0 to {MAX_WAIT_SECONDS}, or exactly $name.", invalid=-1),
        "until": _until_field,
        "event_id": _str("must be the catalog id of a time or external event in this space."),
    },
)
_statement = _obj(
    "One comparison.",
    {
        "x": {"type": "scalar", "requirement": "must be a literal or a $parameter (optionally .field).", "required": True, "invalid": {"bad": True}},
        "operator": _enum(_STEP_OPS, required=True),
        "y": {"type": "scalar", "requirement": "must be a literal or a $parameter (optionally .field).", "invalid": {"bad": True}},
    },
    check=_check_statement,
)
_group = _obj(
    "One group of comparisons.",
    {
        "statement_junction": _enum(_JUNCTIONS),
        "statements": _arr("must contain at least one comparison.", _statement, required=True, minimum=1),
    },
)
_assignment = _obj(
    "One value written when the evaluation matches.",
    {
        "when": _enum(("true", "false", "always"), required=True),
        "type": _enum(("boolean", "string", "number"), required=True),
        "key": _str("must be a parameter name.", required=True, pattern=_PARAM, invalid="1bad"),
        "value": {"type": "scalar", "requirement": "must be a literal, not a $parameter.", "required": True, "invalid": {"bad": True}},
        "collision": _enum(_COLLISIONS),
    },
    check=_check_assignment,
)
_operation_step = _obj(
    "Operation STEP. It evaluates a boolean from the current run and writes literals back.",
    {
        "name": _str("must be a parameter name.", required=True, pattern=_PARAM, invalid="1bad"),
        "collision": _enum(_COLLISIONS),
        "group_junction": _enum(_JUNCTIONS),
        "groups": _arr("must contain at least one group.", _group, required=True, minimum=1),
        "assignments": _arr("must be an array of assignments.", _assignment),
    },
)
_where = _obj(
    "One filter on the matched node.",
    {
        "property_key": _labeled("must be a property name.", required=True),
        "operator": _enum(_WHERE_OPS),
        "value": _str("must be a literal or $parameter."),
    },
    check=_check_where,
)
_return_item = _obj(
    "One return column.",
    {
        "expression": _str("must be a Cypher expression. Call the matched node n.", required=True),
        "alias": _str("must start with a letter. Spaces and punctuation become underscores."),
    },
)
_op_parameter = _obj(
    "One run-time input, referenced as $name.",
    {
        "name": _str("must be a letter or underscore, then letters, digits, or underscores.", required=True, pattern=_PARAM, invalid="1bad"),
        "value_type": _enum(_PARAM_TYPES),
        "value": _str("must be a string default."),
        "is_required": _bool(),
    },
    check=_check_parameter,
)
_op_parameter["fields"]["value_type"]["invalid"] = "text"
_seq_parameter = _obj(
    "One sequence binding.",
    {
        "name": _str("must be a parameter name on this chain.", required=True, pattern=_PARAM, invalid="1bad"),
        "value": {"type": "scalar", "requirement": "must be a string, number, or boolean.", "invalid": {"bad": True}},
    },
)
_collect = _obj(
    "One collected column.",
    {
        "from": _str("must be the return alias to read.", required=True, pattern=_PARAM, invalid="1bad"),
        "as": _str("must be a new name. It cannot be the same as from.", required=True, pattern=_PARAM, invalid="1bad"),
        "reduce": _enum(_REDUCE),
    },
)
_condition = _obj(
    "The test that ends a for/while loop.",
    {
        "parameter": _str("must be the parameter to test.", required=True, pattern=_PARAM, invalid="1bad"),
        "operator": _enum(_LOOP_OPS, required=True),
        "value": _str("must be the value to compare against."),
    },
)
_loop = _obj(
    "How many times the sequence walks.",
    {
        "type": _enum(_LOOP_TYPES, required=True),
        "count": _int("must be a whole number, 0 or more.", minimum=0, invalid=-1),
        "condition": _condition,
        "source": _str("must be the return alias to iterate.", pattern=_PARAM, invalid="1bad"),
        "max_iterations": _int("must be a whole number, 0 or more.", minimum=0, invalid=-1),
        "delay_seconds": _int("must be a whole number of seconds, 0 or more.", minimum=0, invalid=-1),
        "collect": _arr("must be an array of collected columns.", _collect),
    },
)
_vector = _obj(
    "Semantic search on a read INSTANCE.",
    {
        "enabled": _bool(),
        "text": _str("must be the search text, or exactly $name."),
        "k": _duration(f"must be a whole number from 1 to {MAX_VECTOR_K}, or exactly $name.", minimum=1, maximum=MAX_VECTOR_K, integer=True, invalid=0),
        "all_labels": _bool(),
    },
)
_instance_property = _obj(
    "One property value on a new INSTANCE.",
    {
        "key": _labeled("must be a property name on the SCHEMA.", required=True),
        "value": _str("must be a literal or a $parameter. Not alias.field."),
    },
)

_filter = _obj(
    "One test against the inbound payload.",
    {
        "path": _str("must be a dot path into the payload.", required=True),
        "operator": _enum(_FILTER_OPS),
        "value": _str("must be the value to compare. Omit it when the operator is exists."),
    },
)
_mapping = _obj(
    "One value copied from the inbound payload into a sequence parameter.",
    {
        "source_path": _str("must be a dot path into the payload.", required=True),
        "parameter": _str("must be the parameter name.", required=True, pattern=_PARAM, invalid="1bad"),
    },
)
_group_rule = _obj(
    "One schedule group. is_time is always ANDed with the day match.",
    {
        "combinator": _enum(_JUNCTIONS),
        "is_time": _time_field,
        "is_weekday": _arr("must be weekdays 1 through 7. 1 is Monday.", _int("must be a weekday from 1 (Monday) through 7 (Sunday).", minimum=1, maximum=7, invalid=8)),
        "is_month": _arr("must be months 1 through 12.", _int("must be a month from 1 through 12.", minimum=1, maximum=12, invalid=13)),
        "is_date_ordinal": _arr("must be days of the month, 1 through 31.", _int("must be a day of the month from 1 through 31.", minimum=1, maximum=31, invalid=32)),
        "is_year": _arr("must be years.", _int("must be a four-digit year.", minimum=1, maximum=9999, invalid=10000)),
        "is_date": _date_field,
    },
)
_event_package = _obj(
    "When a time event fires.",
    {
        "timezone": _zone_field,
        "combinator": _enum(_JUNCTIONS),
        "groups": _arr("must be an array of schedule groups.", _group_rule),
        "parameters": _free,
    },
)
_external = _obj(
    "What inbound payload fires an external event.",
    {
        "combinator": _enum(_JUNCTIONS),
        "filters": _arr("must be an array of filters.", _filter),
        "param_mappings": _arr("must be an array of parameter mappings.", _mapping),
        "parameters": _free,
    },
)
_outcome = _obj(
    "One weighted result of a probability.",
    {
        "id": _str("must be a string."),
        "label": _str("must name the outcome.", required=True),
        "weight": {"type": "scalar", "requirement": "must be a number, a numeric string, or exactly $name.", "required": True, "invalid": {"bad": True}},
        "weight_sequence_id": _str("must be a sequence id, or empty."),
        "payload": _free,
        "payload_mode": _enum(("fields", "json")),
    },
)
_schedule = _obj(
    "When a probability is allowed to fire.",
    {
        "type": _enum(("recurring", "scheduled", "random"), required=True),
        "every_x": _int("must be a whole number of tics, at least 1.", minimum=1, invalid=0),
        "delay_y": _int("must be a whole number of tics to wait before the first fire.", minimum=0, invalid=-1),
        "percent": _int("must be a whole number from 0 through 100.", minimum=0, maximum=100, invalid=101),
        "tics": _arr("must be the tic numbers this probability fires on.", _int("must be a whole number, 0 or more.", minimum=0, invalid=-1), minimum=1),
    },
)
_probability = _obj(
    "One simulated probability.",
    {
        "id": _str("must be a string."),
        "name": _str("must name the probability.", required=True),
        "description": _str("must be a string."),
        "priority": _int("must be a whole number. Lower runs first.", invalid="x"),
        "schedule": _schedule,
        "outcomes": _arr("must contain at least one outcome.", _outcome, required=True, minimum=1),
    },
)
_simulation = _obj(
    "How a simulated event advances.",
    {
        "token": _str("must be a string."),
        "tic_unit": _enum(("seconds", "minutes", "hours", "days")),
        "tic_duration": _int("must be a whole number of units, at least 1.", minimum=1, invalid=0),
        "sequence_id": _str("must be a sequence id, or empty."),
        "console_id": _str("must be a console id, or empty."),
        "probabilities": _arr("must be an array of probabilities.", _probability),
    },
)

_view = _obj(
    "One console view.",
    {
        "id": _str("must be a string."),
        "name": _str("must be the view name."),
        "kind": _enum(("live", "form")),
        "modules": _arr("must be an array of modules.", _module),
        "dataSequenceId": _str("Set it to the read that fills the form."),
        "actionSequenceId": _str("Set it to the sequence that runs on submit."),
        "submitLabel": _str("must be the submit button label."),
        "fields": _FORM_FIELDS,
    },
)
_document = _obj(
    "Console views.",
    {
        "views": _arr("must be an array of views.", _view),
        "activeViewId": _str("must be the id of one of the views."),
    },
)


def _check_endpoint(value: Any, path: str, problems: list[str]) -> None:
    if not isinstance(value, str):
        return
    text = value.strip()
    if _DOLLAR.fullmatch(text) or _URL.fullmatch(text):
        return
    _fail(problems, path, "must be an absolute http or https URL, or exactly $name.")


_http["fields"]["endpoint"]["check"] = _check_endpoint


_hop = _obj(
    "One same-kind POINTS_TO hop after the anchor node.",
    {
        "relationship_label": _labeled("must be a lowercase name.", required=True),
        "target_label": _labeled("must be the label of the node this hop reaches.", required=True),
        "target_source": _enum(("new", "existing")),
        "instance_properties": _arr("must be property values on a new INSTANCE target.", _instance_property),
    },
)


def _operation_fields() -> dict[str, Any]:
    return {
        "id": _str("must be a catalog id. Omit it to create."),
        "name": _str("must name the operation.", required=True),
        "kind": _enum(("operation",), required=True),
        "operation": _enum(("create", "read", "update", "delete"), required=True),
        "node_label": _enum(("STEP", "SCHEMA", "INSTANCE"), required=True),
        "attributive_label": _labeled("must be a lowercase name. For INSTANCE it names the SCHEMA."),
        "schema_properties": _properties_spec("key"),
        "instance_properties": _arr("must be an array of property values.", _instance_property),
        "where": _arr("must be an array of filters.", _where),
        "return_items": _arr("must be an array of return columns.", _return_item),
        "unwind": _obj(
            "READ only. Stacks expressions into rows.",
            {
                "alias": _str("must be the column name.", required=True, pattern=_PARAM, invalid="1bad"),
                "expressions": _arr("must contain at least two expressions.", _str("must be a Cypher expression."), required=True, minimum=2),
            },
        ),
        "set_expressions": _arr("must be an array of SET expressions. Call the matched node n.", _str("must be an assignment, for example n.status = $status.")),
        "delete_targets": _arr("must be an array of variables to delete.", _str("must be a variable, usually n.")),
        "parameters": _arr("must be an array of parameters.", _op_parameter),
        "limit": _int("must be a whole number, at least 1.", minimum=1, invalid=0),
        "vector_search": _vector,
        "anchor_source": _enum(("new", "existing")),
        "hops": _arr("must be same-kind hops after the anchor node.", _hop),
        "http_step": _http,
        "wait_step": _wait,
        "join_step": _obj("A join step has no settings.", {}),
        "operation_step": _operation_step,
        "add_as_sequence": _bool("must be true or false. Only a single new STEP can be published as a sequence."),
        "execute": _bool("must be true or false. Only a create INSTANCE or SCHEMA runs on accept."),
        "runtime_enabled": _bool(),
        "is_vectorized": _bool(),
        "description": _str("must be a string."),
        "group_title": _str("must be a string."),
    }


def _sequence_fields() -> dict[str, Any]:
    return {
        "id": _str("must be a catalog id. Omit it to create."),
        "name": _str("must name the sequence.", required=True),
        "kind": _enum(("sequence",), required=True),
        "entry_step": _labeled("must be the STEP attributive_label the run starts at.", required=True),
        "traversal": _enum(("downstream", "single")),
        "parameters": _arr("must be an array of bindings.", _seq_parameter),
        "loop": _loop,
        "description": _str("must be a string."),
        "group_title": _str("must be a string."),
    }


def _build_specs() -> dict[str, dict[str, Any]]:
    text = _str("must be a string.")
    return {
        "create_space": _root(
            "A new space.",
            {
                "name": _str("must be the space name.", required=True),
                "description": text,
                "endpoint": _url(),
            },
        ),
        "upsert_schema": _root(
            "A SCHEMA property contract.",
            {
                "attributive_label": _labeled("must be a lowercase name. It belongs to this schema alone.", required=True),
                "name": _str("must be the saved operation name. It defaults to the label."),
                "properties": _properties_spec("name"),
                "is_vectorized": _bool(),
                "description": text,
                "group_title": text,
                "schema_id": _str("must be the existing schema node id when update_existing is true."),
                "update_existing": _bool(),
            },
        ),
        "update_space": _root(
            "Space settings. name is the current name when you are only changing another field.",
            {
                "name": _str("must be the space name.", required=True),
                "endpoint": _url(),
                "description": text,
                "dev_mode": _bool(),
            },
        ),
        "upsert_credential": _root(
            "A credential name. The user types the secret on the proposal.",
            {"name": _credential_field, "description": text},
        ),
        "update_chat_model": _root(
            "Chat model settings. Do not send an API key.",
            {
                "provider": _enum(("platform", "anthropic", "openai", "gemini", "local_llm")),
                "model": text,
                "credential_name": _str(
                    "must be the name of a credential that already exists, or one proposed in this batch.",
                    invalid="***",
                ),
                "local_llm_base_url": _url("must be an absolute http or https URL."),
                "local_llm_config_id": text,
                "max_rounds": _int(f"must be a whole number from {MIN_ROUNDS} through {MAX_ROUNDS}.", minimum=MIN_ROUNDS, maximum=MAX_ROUNDS, invalid=3),
                "role": _enum(("planner", "surface", "builder")),
            },
        ),
        "update_embeddings": _root(
            "Embedding settings for this space.",
            {
                "enabled": _bool(required=True),
                "provider": _enum(("ollama", "gemini")),
                "ollama_url": _url(),
                "base_url": _url(),
                "embed_model": text,
                "credential": _str("must be a credential name.", invalid="***"),
            },
        ),
        "reindex_embeddings": _root("Reindex takes no fields. Put it after a vectorized schema in the same batch.", {}),
        "invite_member": _root(
            "Invite a person to this space.",
            {"email": _email_field, "role": _str("must be a role id or name.")},
        ),
        "update_member": _root(
            "Change a member's role or ownership.",
            {
                "member_id": _str("must be the membership id.", required=True),
                "role": _str("must be a role id or name."),
                "is_owner": _bool(),
            },
        ),
        "update_role": _root(
            "A role. permissions.flows use operation:ELEMENT, for example read:STEP.",
            {
                "id": _str("must be a role id. Omit it to create."),
                "name": _str("must be the role name.", required=True),
                "permissions": _obj(
                    "What the role can do.",
                    {
                        "flows": _arr("must be an array of operation:ELEMENT flows.", _flow_field, required=True),
                        "sequences": _obj(
                            "Which sequences this role can run.",
                            {
                                "all": _bool(required=True),
                                "ids": _arr("must be an array of sequence ids.", _str("must be a sequence id."), required=True),
                            },
                            required=True,
                        ),
                        "manage_space": _bool(required=True),
                    },
                    required=True,
                ),
            },
        ),
        "create_agent_key": _root(
            "An agent key. The token is shown once after accept.",
            {"name": _str("must name the key.", required=True), "role": _str("must be a role id or name.")},
        ),
        "revoke_agent_key": _root("Revoke one agent key.", {"id": _str("must be the key id.", required=True)}),
        "update_tab_chrome": _root("The browser-tab label for this instance.", {"icon_label": _icon_field}),
        "upsert_event": _root(
            "An event. A time event puts its clock in event_package.groups.",
            {
                "id": _str("must be a catalog id. Omit it to create."),
                "name": _str("must be the event name.", required=True),
                "type": _enum(("time", "external", "simulated"), required=True),
                "event_package": _event_package,
                "sequences": _arr("must be an array of sequence ids.", _str("must be a sequence id.")),
                "recovery_sequences": _arr("must be an array of sequence ids.", _str("must be a sequence id.")),
                "enabled": {"type": "bit", "requirement": "must be true, false, 0, or 1.", "invalid": "yes"},
                "external_package": _external,
                "simulation_package": _simulation,
            },
        ),
        "delete_event": _root("Delete one event.", {"id": _str("must be the event id.", required=True)}),
        "upsert_console": _root(
            "A console. Every module sets dataSequenceId. A form also sets actionSequenceId.",
            {
                "id": _str("must be a catalog id. Omit it to create."),
                "name": _str("must be the console name.", required=True),
                "trigger_kind": _enum(("", "url", "event")),
                "listen_url": _url(),
                "trigger_event_id": _str("must be the id of a time or external event. A simulated event cannot trigger a console."),
                "document": _document,
            },
        ),
        "delete_console": _root("Delete one console.", {"id": _str("must be the console id.", required=True)}),
        "delete_sequence": _root("Delete one sequence from the catalog. STEP nodes stay.", {"id": _str("must be the sequence id.", required=True)}),
        "delete_operation": _root("Delete one operation, its wrap step, and its one-step sequence.", {"id": _str("must be the operation id.", required=True)}),
        "delete_step": _root("Delete one STEP by attributive_label.", {"attributive_label": _labeled("must be the STEP name.", required=True)}),
        "delete_schema": _root("Delete one SCHEMA by attributive_label.", {"attributive_label": _labeled("must be the SCHEMA name.", required=True)}),
        "create_transition": _root(
            "A POINTS_TO edge from one STEP to another.",
            {
                "from_step": _labeled("must be the STEP the edge leaves.", required=True),
                "to_step": _labeled("must be the STEP the edge enters.", required=True),
                "relationship_label": _labeled("must be a lowercase name. It defaults to next."),
                "condition_type": _enum(("null", "parameter", "cypher", "implicit", "query")),
                "condition": _str("must be the condition expression."),
                "condition_expected": _bool("must be true or false. Used when condition_type is parameter."),
            },
        ),
    }


_SPECS = _build_specs()
_SPECS["update_embeddings"]["fields"]["credential"]["check"] = _check_credential_name
_SPECS["update_chat_model"]["fields"]["credential_name"]["check"] = _check_credential_name
_OPERATION = _root("A saved operation.", _operation_fields())
_SEQUENCE = _root("A saved sequence.", _sequence_fields())

KINDS = (
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
)


def spec_for(kind: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    if kind == "upsert_query":
        query_kind = str(payload.get("kind") or "operation").strip().lower()
        return _SEQUENCE if query_kind == "sequence" else _OPERATION
    return _SPECS.get(kind)


def _named_specs() -> list[tuple[str, dict[str, Any]]]:
    names = [(name, spec) for name, spec in _SPECS.items() if name != "upsert_query"]
    names.append(("upsert_query operation", _OPERATION))
    names.append(("upsert_query sequence", _SEQUENCE))
    return names


def align_payload(kind: str, payload: dict[str, Any]) -> None:
    """Rewrite casing and aliases the product already accepts, before the check."""
    if not isinstance(payload, dict):
        return
    for key in _LABEL_KEYS.get(kind, ()):
        _align_label(payload, key)
    if kind == "upsert_schema" and isinstance(payload.get("properties"), list):
        payload.pop("schemata", None)
        for prop in payload["properties"]:
            if isinstance(prop, dict):
                _align_label(prop, "name")
                _align_label(prop, "key")
                if "value_type" in prop:
                    prop["value_type"] = _canon(prop.get("value_type"), _SCHEMA_TYPES)
    if kind == "upsert_credential":
        _align_credential(payload, "name")
    if kind == "update_chat_model":
        _align_credential(payload, "credential_name")
    if kind == "update_embeddings":
        _align_credential(payload, "credential")
    if kind == "upsert_query":
        _align_enum(payload, "kind", ("operation", "sequence"))
        _align_enum(payload, "operation", ("create", "read", "update", "delete"))
        _align_enum(payload, "node_label", ("STEP", "SCHEMA", "INSTANCE"))
        _align_enum(payload, "traversal", ("downstream", "single"))
        _align_query(payload)
    if kind == "create_transition":
        _align_enum(payload, "condition_type", ("null", "parameter", "cypher", "implicit", "query"))
    if kind == "update_chat_model":
        _align_enum(payload, "provider", ("platform", "anthropic", "openai", "gemini", "local_llm"))
    if kind == "update_embeddings":
        _align_enum(payload, "provider", ("ollama", "gemini"))
    if kind == "upsert_event":
        _align_enum(payload, "type", ("time", "external", "simulated"))
        _align_event(payload)
    if kind == "upsert_console":
        for old, new in (("triggerKind", "trigger_kind"), ("triggerEventId", "trigger_event_id"), ("listenUrl", "listen_url")):
            if not str(payload.get(new) or "").strip() and payload.get(old) not in (None, ""):
                payload[new] = payload.get(old)
            payload.pop(old, None)
        _align_enum(payload, "trigger_kind", ("", "url", "event"))
        document = payload.get("document")
        if isinstance(document, dict):
            align_console_document(document)


def _align_credential(payload: dict[str, Any], key: str) -> None:
    raw = payload.get(key)
    if not isinstance(raw, str) or not raw.strip():
        return
    try:
        from .credentials import validate_credential_name

        payload[key] = validate_credential_name(raw)
    except ValueError:
        pass


def _align_query(payload: dict[str, Any]) -> None:
    http = payload.get("http_step")
    if isinstance(http, dict):
        _align_enum(http, "method", _HTTP_METHODS)
    wait = payload.get("wait_step")
    if isinstance(wait, dict):
        _align_enum(wait, "mode", ("duration", "until", "event"))
    step = payload.get("operation_step")
    if isinstance(step, dict):
        _align_enum(step, "collision", _COLLISIONS)
        _align_enum(step, "group_junction", _JUNCTIONS)
        for group in step.get("groups") or []:
            if not isinstance(group, dict):
                continue
            _align_enum(group, "statement_junction", _JUNCTIONS)
            for statement in group.get("statements") or []:
                if isinstance(statement, dict):
                    _align_enum(statement, "operator", _STEP_OPS)
        for assignment in step.get("assignments") or []:
            if not isinstance(assignment, dict):
                continue
            _align_enum(assignment, "when", ("true", "false", "always"))
            _align_enum(assignment, "type", ("boolean", "string", "number"))
            _align_enum(assignment, "collision", _COLLISIONS)
    for row in payload.get("where") or []:
        if isinstance(row, dict):
            _align_enum(row, "operator", _WHERE_OPS)
            _align_label(row, "property_key")
    for prop in payload.get("schema_properties") or []:
        if isinstance(prop, dict):
            _align_label(prop, "key")
            if "value_type" in prop:
                prop["value_type"] = _canon(prop.get("value_type"), _SCHEMA_TYPES)
    for prop in payload.get("instance_properties") or []:
        if isinstance(prop, dict):
            _align_label(prop, "key")
    for param in payload.get("parameters") or []:
        if isinstance(param, dict) and "value_type" in param:
            param["value_type"] = _canon(param.get("value_type"), _PARAM_TYPES)
    loop = payload.get("loop")
    if isinstance(loop, dict):
        _align_enum(loop, "type", _LOOP_TYPES)
        condition = loop.get("condition")
        if isinstance(condition, dict):
            _align_enum(condition, "operator", _LOOP_OPS)
        for item in loop.get("collect") or []:
            if isinstance(item, dict):
                _align_enum(item, "reduce", _REDUCE)


def _align_event(payload: dict[str, Any]) -> None:
    package = payload.get("event_package")
    if isinstance(package, dict):
        _align_enum(package, "combinator", _JUNCTIONS)
        for group in package.get("groups") or []:
            if isinstance(group, dict):
                _align_enum(group, "combinator", _JUNCTIONS)
    external = payload.get("external_package")
    if isinstance(external, dict):
        _align_enum(external, "combinator", _JUNCTIONS)
        for filt in external.get("filters") or []:
            if isinstance(filt, dict):
                _align_enum(filt, "operator", _FILTER_OPS)
    simulation = payload.get("simulation_package")
    if isinstance(simulation, dict):
        _align_enum(simulation, "tic_unit", ("seconds", "minutes", "hours", "days"))
        for probability in simulation.get("probabilities") or []:
            if not isinstance(probability, dict):
                continue
            schedule = probability.get("schedule")
            if isinstance(schedule, dict):
                _align_enum(schedule, "type", ("recurring", "scheduled", "random"))
            for outcome in probability.get("outcomes") or []:
                if isinstance(outcome, dict):
                    _align_enum(outcome, "payload_mode", ("fields", "json"))


def align_console_document(document: dict[str, Any]) -> None:
    """Mint ids and copy sequence aliases onto the names the console reads."""
    views = document.get("views")
    if isinstance(views, dict):
        converted = []
        for key, view in views.items():
            if isinstance(view, dict):
                if not str(view.get("id") or "").strip():
                    view["id"] = str(key)
                converted.append(view)
        document["views"] = converted
        views = converted
    if not isinstance(views, list):
        return
    for view in views:
        if not isinstance(view, dict):
            continue
        if not str(view.get("id") or "").strip():
            view["id"] = id_generator.generate_id()
        _align_enum(view, "kind", ("live", "form"))
        modules = view.get("modules")
        if isinstance(modules, dict):
            view["modules"] = [item for item in modules.values() if isinstance(item, dict)]
            modules = view["modules"]
        if isinstance(modules, list):
            for module in modules:
                if isinstance(module, dict):
                    _align_module(module)
        _move_sequence(view, ("data_sequence_id",), "dataSequenceId")
        _move_sequence(view, ("action_sequence_id",), "actionSequenceId")


def _move_sequence(holder: dict[str, Any], aliases: tuple[str, ...], canonical: str) -> None:
    current = str(holder.get(canonical) or "").strip()
    for alias in aliases:
        raw = holder.get(alias)
        text = str(raw).strip() if isinstance(raw, str) else ""
        if text and not current:
            holder[canonical] = text
            current = text
        if text and current == text:
            holder.pop(alias, None)


def _align_module(module: dict[str, Any]) -> None:
    if not str(module.get("id") or "").strip():
        module["id"] = id_generator.generate_id()
    _move_sequence(module, ("data_sequence_id", "sequenceId", "sequence_id"), "dataSequenceId")
    _move_sequence(module, ("action_sequence_id",), "actionSequenceId")
    _align_enum(module, "type", _MODULE_TYPES)
    _align_enum(module, "dataSource", ("sequence", "url"))
    _align_enum(module, "actionSource", ("sequence", "url"))
    if str(module.get("dataSequenceId") or "").strip() and not str(module.get("dataSource") or "").strip():
        module["dataSource"] = "sequence"
    if str(module.get("actionSequenceId") or "").strip() and not str(module.get("actionSource") or "").strip():
        module["actionSource"] = "sequence"
    if not str(module.get("title") or "").strip() and str(module.get("type") or "").strip():
        module["title"] = str(module.get("type"))
    if "config" not in module or module.get("config") is None:
        module["config"] = {}
    config = module.get("config")
    if not isinstance(config, dict):
        return
    if "fields" in module and "fields" not in config:
        config["fields"] = module.pop("fields")
    fields = config.get("fields")
    if isinstance(fields, list):
        for field in fields:
            if isinstance(field, dict):
                _align_enum(field, "type", _FORM_FIELD_TYPES)


def _rules(kind: str, payload: dict[str, Any], problems: list[str]) -> None:
    if kind == "upsert_query":
        _rules_query(payload, problems)
    elif kind == "upsert_event":
        _rules_event(payload, problems)
    elif kind == "upsert_console":
        _rules_console(payload, problems)
    elif kind == "update_embeddings":
        if payload.get("provider") == "gemini" and not str(payload.get("credential") or "").strip():
            _fail(problems, "payload.credential", "is required when the provider is gemini.")
    elif kind == "create_transition":
        condition_type = str(payload.get("condition_type") or "null")
        if condition_type in ("parameter", "cypher", "query") and not str(payload.get("condition") or "").strip():
            _fail(problems, "payload.condition", f"is required when condition_type is {condition_type}.")


def _rules_query(payload: dict[str, Any], problems: list[str]) -> None:
    if str(payload.get("kind") or "operation") == "sequence":
        _rules_sequence(payload, problems)
        return
    operation = str(payload.get("operation") or "")
    label = str(payload.get("node_label") or "")
    steps = [name for name in _STEP_KEYS if isinstance(payload.get(name), dict)]
    if operation == "create" and label == "STEP":
        if len(steps) > 1:
            _fail(problems, "payload", f"{', '.join(steps)} are mutually exclusive. A create STEP has one of http_step, wait_step, join_step, or operation_step.")
        elif not steps:
            _fail(problems, "payload", "needs http_step, wait_step, join_step, or operation_step.")
        if payload.get("execute") is True:
            _fail(problems, "payload.execute", "is only for a create INSTANCE or SCHEMA. A STEP is saved, not executed.")
        if str(payload.get("attributive_label") or "").startswith("$"):
            _fail(problems, "payload.attributive_label", "must be a literal name, not a $parameter.")
    elif steps:
        _fail(problems, "payload." + steps[0], "is only for a create STEP.")
    if operation == "create" and label in ("INSTANCE", "SCHEMA") and not str(payload.get("attributive_label") or "").strip():
        _fail(problems, "payload.attributive_label", "is required. For INSTANCE it names the SCHEMA. For SCHEMA it is the new name.")
    if operation == "create" and label == "INSTANCE":
        _reject_row_fields(payload, problems)
    if operation != "create" and payload.get("execute") is True:
        _fail(problems, "payload.execute", "is only for a create INSTANCE or SCHEMA.")
    if payload.get("add_as_sequence") is True and not (operation == "create" and label == "STEP"):
        _fail(problems, "payload.add_as_sequence", "is only for a single new STEP.")
    _only(payload, problems, "return_items", operation == "read", "return_items is only for a read.")
    _only(payload, problems, "limit", operation == "read", "limit is only for a read.")
    _only(payload, problems, "unwind", operation == "read", "UNWIND is only for a read. A create INSTANCE writes one row. Set the key property to a literal value or a $parameter, and propose one executed create per row.")
    _only(payload, problems, "set_expressions", operation == "update", "set_expressions is only for an update.")
    _only(payload, problems, "delete_targets", operation == "delete", "delete_targets is only for a delete.")
    _only(payload, problems, "where", operation in ("read", "update", "delete"), "where is only for read, update, or delete.")
    _only(payload, problems, "schema_properties", operation == "create" and label == "SCHEMA", "schema_properties is only for a create SCHEMA.")
    _only(payload, problems, "instance_properties", label == "INSTANCE", "instance_properties is only for an INSTANCE.")
    _only(payload, problems, "is_vectorized", operation == "create" and label == "SCHEMA", "is_vectorized is only for a create SCHEMA.")
    vector = payload.get("vector_search") if isinstance(payload.get("vector_search"), dict) else None
    if vector is not None and (operation != "read" or label != "INSTANCE"):
        _fail(problems, "payload.vector_search", "is only for a read INSTANCE.")
    hops = payload.get("hops")
    if hops:
        if operation not in ("create", "read"):
            _fail(problems, "payload.hops", "is only for a create or a read.")
        if vector and vector.get("enabled") is not False:
            _fail(problems, "payload.hops", "is not combined with vector search. Search names a record, then a later step walks.")
        for index, hop in enumerate(hops if isinstance(hops, list) else []):
            if not isinstance(hop, dict):
                continue
            if hop.get("instance_properties") and not (
                operation == "create" and label == "INSTANCE" and hop.get("target_source") == "new"
            ):
                _fail(
                    problems,
                    f"payload.hops[{index}].instance_properties",
                    "is only for a new INSTANCE at the end of a create.",
                )
    if vector and vector.get("enabled") is not False:
        if payload.get("unwind"):
            _fail(problems, "payload.unwind", "is not combined with vector search.")
        if payload.get("return_items"):
            _fail(problems, "payload.return_items", "is not combined with vector search. The search returns the matched nodes and a score.")
        if payload.get("limit") is not None:
            _fail(problems, "payload.limit", "is not combined with vector search. Set vector_search.k instead.")
        if not str(vector.get("text") or "").strip():
            _fail(problems, "payload.vector_search.text", "is required. Use a literal or exactly $name.")
    if isinstance(payload.get("wait_step"), dict):
        _rules_wait(payload["wait_step"], problems)
    if isinstance(payload.get("http_step"), dict):
        _rules_http(payload["http_step"], problems)
    if operation == "update" and label == "INSTANCE":
        expressions = payload.get("set_expressions")
        if not isinstance(expressions, list) or not any(str(item).strip() for item in expressions):
            _fail(problems, "payload.set_expressions", "is required. An INSTANCE update needs at least one assignment, for example n.status = $status.")
    if isinstance(payload.get("schema_properties"), list):
        _one_label(payload["schema_properties"], "payload.schema_properties", problems)


def _only(payload: dict[str, Any], problems: list[str], key: str, allowed: bool, text: str) -> None:
    if key in payload and not allowed:
        _fail(problems, f"payload.{key}", text)


def _rules_http(http: dict[str, Any], problems: list[str]) -> None:
    seen: set[str] = set()
    for index, row in enumerate(http.get("response_parameters") or []):
        if not isinstance(row, dict):
            continue
        name = str(row.get("parameter") or "").strip()
        if not name:
            continue
        if name in seen:
            _fail(problems, f"payload.http_step.response_parameters[{index}].parameter", f"{name} is already mapped.")
        seen.add(name)


def _rules_wait(wait: dict[str, Any], problems: list[str]) -> None:
    mode = wait.get("mode")
    if mode == "duration" and "duration_seconds" not in wait:
        _fail(problems, "payload.wait_step.duration_seconds", f"is required when mode is duration. Use seconds, at most {MAX_WAIT_SECONDS}, or exactly $name.")
    if mode == "until" and not str(wait.get("until") or "").strip():
        _fail(problems, "payload.wait_step.until", "is required when mode is until.")
    if mode == "event" and not str(wait.get("event_id") or "").strip():
        _fail(problems, "payload.wait_step.event_id", "is required when mode is event.")
    extra = {"duration": ("until", "event_id"), "until": ("duration_seconds", "event_id"), "event": ("duration_seconds", "until")}.get(str(mode), ())
    for key in extra:
        if key in wait:
            _fail(problems, f"payload.wait_step.{key}", f"is not used when mode is {mode}.")


def _rules_sequence(payload: dict[str, Any], problems: list[str]) -> None:
    loop = payload.get("loop")
    if not isinstance(loop, dict):
        return
    loop_type = loop.get("type")
    if loop_type == "for" and "count" not in loop:
        _fail(problems, "payload.loop.count", "is required when type is for.")
    if loop_type == "for_while":
        condition = loop.get("condition") if isinstance(loop.get("condition"), dict) else {}
        if not str(condition.get("parameter") or "").strip():
            _fail(problems, "payload.loop.condition.parameter", "is required when type is for_while.")
        if not condition.get("operator"):
            _fail(problems, "payload.loop.condition.operator", "is required when type is for_while.")
    if loop_type == "for_each" and not str(loop.get("source") or "").strip():
        _fail(problems, "payload.loop.source", "is required when type is for_each. Name the return alias to iterate.")
    count = loop.get("count")
    cap = loop.get("max_iterations")
    if isinstance(count, int) and not isinstance(count, bool) and isinstance(cap, int) and not isinstance(cap, bool) and cap and count > cap:
        _fail(problems, "payload.loop.count", f"cannot be greater than max_iterations ({cap}).")
    seen: set[str] = set()
    for index, item in enumerate(loop.get("collect") or []):
        if not isinstance(item, dict):
            continue
        source = str(item.get("from") or "").strip()
        alias = str(item.get("as") or "").strip()
        if source and alias and source == alias:
            _fail(problems, f"payload.loop.collect[{index}].as", f"cannot publish {source} onto itself.")
        if alias:
            if alias in seen:
                _fail(problems, f"payload.loop.collect[{index}].as", f"publishes {alias} more than once.")
            seen.add(alias)


def _reject_row_fields(payload: dict[str, Any], problems: list[str]) -> None:
    properties = payload.get("instance_properties") if isinstance(payload.get("instance_properties"), list) else []
    aliases: set[str] = set()
    dotted = 0
    for entry in properties:
        if not isinstance(entry, dict):
            continue
        match = _ROW_FIELD.fullmatch(str(entry.get("value") or "").strip())
        if not match:
            continue
        aliases.add(match.group(1))
        dotted += 1
    if dotted >= 2 and len(aliases) == 1:
        alias = next(iter(aliases))
        _fail(
            problems,
            "payload.instance_properties",
            f"is set to {alias}.field. A create writes one instance, so set each property to a literal value or a $parameter. To seed several rows, propose one executed create per row.",
        )


def _rules_event(payload: dict[str, Any], problems: list[str]) -> None:
    event_type = str(payload.get("type") or "")
    package = payload.get("event_package") if isinstance(payload.get("event_package"), dict) else {}
    groups = [group for group in package.get("groups") or [] if isinstance(group, dict)]
    if event_type == "time":
        if not any(_clock(group.get("is_time")) for group in groups):
            _fail(problems, "payload.event_package.groups", "needs a group with is_time set to 24-hour HH:MM, for example 18:00. Weekday 1 is Monday.")
    if event_type != "external" and isinstance(payload.get("external_package"), dict) and payload.get("external_package"):
        _fail(problems, "payload.external_package", "is only for an external event.")
    if event_type != "simulated" and isinstance(payload.get("simulation_package"), dict) and payload.get("simulation_package"):
        _fail(problems, "payload.simulation_package", "is only for a simulated event.")
    external = payload.get("external_package") if isinstance(payload.get("external_package"), dict) else {}
    for index, filt in enumerate(external.get("filters") or []):
        if not isinstance(filt, dict):
            continue
        operator = str(filt.get("operator") or "equals")
        if operator != "exists" and "value" not in filt:
            _fail(problems, f"payload.external_package.filters[{index}].value", "is required unless the operator is exists.")
    simulation = payload.get("simulation_package") if isinstance(payload.get("simulation_package"), dict) else {}
    for index, probability in enumerate(simulation.get("probabilities") or []):
        if not isinstance(probability, dict):
            continue
        schedule = probability.get("schedule") if isinstance(probability.get("schedule"), dict) else {}
        schedule_type = schedule.get("type")
        allowed = {
            "recurring": {"type", "every_x", "delay_y"},
            "scheduled": {"type", "tics"},
            "random": {"type", "every_x", "percent"},
        }.get(str(schedule_type), set())
        for key in schedule:
            if allowed and key not in allowed:
                _fail(problems, f"payload.simulation_package.probabilities[{index}].schedule.{key}", f"is not used when type is {schedule_type}.")
        if schedule_type in ("recurring", "random") and "every_x" not in schedule:
            _fail(problems, f"payload.simulation_package.probabilities[{index}].schedule.every_x", "is required.")
        if schedule_type == "random" and "percent" not in schedule:
            _fail(problems, f"payload.simulation_package.probabilities[{index}].schedule.percent", "is required.")
        if schedule_type == "scheduled" and not schedule.get("tics"):
            _fail(problems, f"payload.simulation_package.probabilities[{index}].schedule.tics", "is required when type is scheduled.")


def _clock(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip().lower()
    if text.endswith("z"):
        text = text[:-1].strip()
    return _TIME.fullmatch(text) is not None


def _rules_console(payload: dict[str, Any], problems: list[str]) -> None:
    if payload.get("trigger_kind") == "url" and not str(payload.get("listen_url") or "").strip():
        _fail(problems, "payload.listen_url", "is required when trigger_kind is url.")
    if payload.get("trigger_kind") == "event" and not str(payload.get("trigger_event_id") or "").strip():
        _fail(problems, "payload.trigger_event_id", "is required when trigger_kind is event. A simulated event cannot trigger a console.")
    document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
    for view_index, view in enumerate(document.get("views") or []):
        if not isinstance(view, dict):
            continue
        view_path = f"payload.document.views[{view_index}]"
        if view.get("kind") == "form":
            if not str(view.get("dataSequenceId") or "").strip():
                _fail(problems, f"{view_path}.dataSequenceId", "is required. A form needs the read that fills its inputs.")
            if not str(view.get("actionSequenceId") or "").strip():
                _fail(problems, f"{view_path}.actionSequenceId", "is required. A form needs the sequence that runs on submit.")
            if str(view.get("dataSequenceId") or "").strip() and view.get("dataSequenceId") == view.get("actionSequenceId"):
                _fail(problems, f"{view_path}.actionSequenceId", "must be a different sequence from dataSequenceId. The form does not load the sequence it submits.")
        for module_index, module in enumerate(view.get("modules") or []):
            if isinstance(module, dict):
                _rules_module(module, f"{view_path}.modules[{module_index}]", problems)


def _rules_module(module: dict[str, Any], path: str, problems: list[str]) -> None:
    module_type = str(module.get("type") or "")
    if module.get("dataSource") not in (None, "", "sequence") and str(module.get("dataSequenceId") or "").strip():
        _fail(problems, f"{path}.dataSource", "must be sequence when dataSequenceId is set.")
    if module_type in _ACTION and not str(module.get("actionSequenceId") or "").strip():
        _fail(problems, f"{path}.actionSequenceId", "is required. This module runs a sequence when the person uses it.")
    if module_type == "form" and module.get("dataSequenceId") and module.get("dataSequenceId") == module.get("actionSequenceId"):
        _fail(problems, f"{path}.actionSequenceId", "must be a different sequence from dataSequenceId.")
    config = module.get("config") if isinstance(module.get("config"), dict) else None
    if module.get("config") is not None and not isinstance(module.get("config"), dict):
        _fail(problems, f"{path}.config", "must be an object.")
        return
    if config is None:
        return
    allowed = CONFIG.get(module_type, {})
    for key, value in config.items():
        if key not in allowed:
            listed = ", ".join(sorted(allowed)) or "none"
            _fail(problems, f"{path}.config.{key}", f"is not a field on a {module_type or 'blank'} module. Allowed config fields: {listed}.")
            continue
        _check(allowed[key], value, f"{path}.config.{key}", problems)


def payload_problems(kind: str, payload: Any) -> list[str]:
    """Human-readable field problems. Empty means the payload matches the field requirements."""
    if not isinstance(payload, dict):
        return ["payload must be an object."]
    if kind not in KINDS:
        return []
    align_payload(kind, payload)
    spec = spec_for(kind, payload)
    problems: list[str] = []
    if spec is None:
        return problems
    _check(spec, payload, "payload", problems)
    _rules(kind, payload, problems)
    return problems


def _spec_paths(spec: dict[str, Any], path: str, stack: tuple[int, ...]) -> Iterator[str]:
    if id(spec) in stack:
        return
    yield path
    nxt = (*stack, id(spec))
    if spec.get("type") == "object":
        for key, child in (spec.get("fields") or {}).items():
            yield from _spec_paths(child, f"{path}.{key}", nxt)
    elif spec.get("type") in ("array", "field_list") and spec.get("items"):
        yield from _spec_paths(spec["items"], f"{path}[]", nxt)


def _covered(spec: dict[str, Any], value: Any, path: str, stack: tuple[int, ...]) -> Iterator[str]:
    if id(spec) in stack:
        return
    yield path
    nxt = (*stack, id(spec))
    if spec.get("type") == "object" and isinstance(value, dict):
        for key, child in (spec.get("fields") or {}).items():
            if key in value:
                yield from _covered(child, value[key], f"{path}.{key}", nxt)
    elif spec.get("type") in ("array", "field_list") and spec.get("items") and isinstance(value, list):
        seen: set[str] = set()
        for item in value:
            for item_path in _covered(spec["items"], item, f"{path}[]", nxt):
                if item_path not in seen:
                    seen.add(item_path)
                    yield item_path


def _concrete(spec: dict[str, Any], value: Any, path: str, stack: tuple[int, ...]) -> Iterator[tuple[str, dict[str, Any]]]:
    if id(spec) in stack:
        return
    yield path, spec
    nxt = (*stack, id(spec))
    if spec.get("type") == "object" and isinstance(value, dict):
        for key, child in (spec.get("fields") or {}).items():
            if key in value:
                yield from _concrete(child, value[key], f"{path}.{key}", nxt)
    elif spec.get("type") in ("array", "field_list") and spec.get("items") and isinstance(value, list):
        for index, item in enumerate(value):
            yield from _concrete(spec["items"], item, f"{path}[{index}]", nxt)


def _flags(**overrides: Any) -> dict[str, Any]:
    flags = {"is_required": False, "is_key": False, "is_label": False, "is_indexed": False}
    flags.update(overrides)
    return flags


def _form_fields() -> list[dict[str, Any]]:
    return [
        {"id": "f_qty", "name": "qty", "label": "Qty", "type": "number", "required": True, "min": 0, "max": 10, "placeholder": "0", "page": 1},
        {"name": "lane", "label": "Lane", "type": "select", "required": False, "options": ["ground", "express"]},
        {"name": "lines", "label": "Lines", "type": "array", "fields": [{"name": "sku", "label": "SKU", "type": "text", "required": False}]},
    ]


def _module_sample(module_type: str, config: dict[str, Any], *, action: str | None = None, data: str = "read_rows") -> dict[str, Any]:
    module: dict[str, Any] = {
        "id": f"m_{module_type}",
        "type": module_type,
        "title": module_type,
        "dataSource": "sequence",
        "dataSequenceId": data,
        "config": config,
    }
    if module_type in _ACTION:
        module["actionSource"] = "sequence"
        module["actionSequenceId"] = action or "submit_row"
    if module_type == "table":
        module["layout"] = {"x": 0, "y": 0, "w": 6, "h": 8, "minW": 4, "minH": 4}
    return module


def _console_modules() -> list[dict[str, Any]]:
    charts = {"dataPath": "", "categoryKey": "name", "valueKey": "value"}
    return [
        _module_sample("stat", {"dataPath": ""}),
        _module_sample("text", {"dataPath": "text"}),
        _module_sample("table", {"dataPath": ""}),
        _module_sample("badge", {"dataPath": ""}),
        _module_sample("progress", {"dataPath": ""}),
        _module_sample("ring", {"dataPath": ""}),
        _module_sample("graph", {"dataPath": ""}),
        _module_sample("donut", {"dataPath": ""}),
        _module_sample("line", {**charts, "color": "accent.4"}),
        _module_sample("bar", {**charts, "color": "violet.5"}),
        _module_sample("area", {**charts, "color": "cyan.4"}),
        _module_sample("alert", {"dataPath": "", "color": "yellow"}),
        _module_sample("button", {"dataPath": "", "label": "run", "color": "accent", "payload": "click"}),
        _module_sample("switch", {"dataPath": "", "label": "enabled"}),
        _module_sample("checkbox", {"dataPath": "", "label": "checked"}),
        _module_sample("segmented", {"dataPath": "", "options": "day, week, month"}),
        _module_sample("select", {"dataPath": "", "label": "choice", "options": "ground, express"}),
        _module_sample("number", {"dataPath": "", "label": "value"}),
        _module_sample("form", {"dataPath": "", "autoRefresh": True, "fields": _form_fields()}, action="submit_form", data="read_form"),
    ]


def _schema_properties() -> list[dict[str, Any]]:
    return [
        {"name": "id", "value_type": "UID", **_flags(is_required=True, is_key=True)},
        {"name": "full_name", "value_type": "string", "format": "any", "default_value": "Ada", "is_embedded": True, **_flags(is_label=True)},
        {"name": "status", "value_type": "radio", "options": ["open", "closed"], "default_value": "open", **_flags()},
        {"name": "tags", "value_type": "checkbox", "options": ["a", "b"], "min_choices": 0, "max_choices": 2, **_flags()},
    ]


def _operation_properties() -> list[dict[str, Any]]:
    return [
        {"key": "id", "value_type": "UID", **_flags(is_required=True, is_key=True)},
        {"key": "full_name", "value_type": "string", "format": "any", "default_value": "Ada", "is_embedded": True, **_flags(is_label=True)},
        {"key": "status", "value_type": "radio", "options": ["open", "closed"], "default_value": "open", **_flags()},
        {"key": "tags", "value_type": "checkbox", "options": ["a", "b"], "min_choices": 0, "max_choices": 2, **_flags()},
    ]


_SAMPLES: list[tuple[str, str, dict[str, Any]]] = [
    ("create_space", "create space", {"name": "Demo", "description": "A desk", "endpoint": "https://example.test"}),
    (
        "upsert_schema",
        "schema",
        {
            "attributive_label": "customer",
            "name": "Customer",
            "properties": _schema_properties(),
            "is_vectorized": True,
            "description": "People",
            "group_title": "Directory",
            "schema_id": "schema_customer",
            "update_existing": True,
        },
    ),
    (
        "upsert_query",
        "read",
        {
            "id": "ID_read",
            "name": "Read people",
            "kind": "operation",
            "operation": "read",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "where": [{"property_key": "status", "operator": "=", "value": "open"}],
            "return_items": [{"expression": "n.name", "alias": "name"}],
            "parameters": [{"name": "status", "value_type": "string", "value": "open", "is_required": True}],
            "limit": 25,
            "runtime_enabled": True,
            "description": "People",
            "group_title": "Directory",
        },
    ),
    (
        "upsert_query",
        "unwind",
        {
            "name": "Stack ids",
            "kind": "operation",
            "operation": "read",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "unwind": {"alias": "entity_id", "expressions": ["SUBJECT.id", "OBJECT.id"]},
        },
    ),
    (
        "upsert_query",
        "vector",
        {
            "name": "Search people",
            "kind": "operation",
            "operation": "read",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "vector_search": {"enabled": True, "text": "kiki", "k": 10, "all_labels": False},
        },
    ),
    (
        "upsert_query",
        "http step",
        {
            "name": "Log shipment",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "log_shipment",
            "add_as_sequence": True,
            "http_step": {
                "endpoint": "https://example.test/shipments",
                "method": "POST",
                "body": {"sku": "$sku"},
                "headers": {"Accept": "application/json"},
                "response_parameters": [{"property_path": "data.id", "parameter": "remote_id", "default_value": ""}],
                "timeout_seconds": 30,
                "max_attempts": 2,
                "backoff_seconds": 1,
            },
        },
    ),
    (
        "upsert_query",
        "wait duration",
        {
            "name": "Wait a bit",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "wait_a_bit",
            "wait_step": {"mode": "duration", "duration_seconds": 30},
        },
    ),
    (
        "upsert_query",
        "wait until",
        {
            "name": "Wait until",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "wait_until",
            "wait_step": {"mode": "until", "until": "2026-11-07T18:00:00Z"},
        },
    ),
    (
        "upsert_query",
        "wait event",
        {
            "name": "Wait for badge",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "wait_badge",
            "wait_step": {"mode": "event", "event_id": "EV_badge"},
        },
    ),
    (
        "upsert_query",
        "join",
        {
            "name": "Join arms",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "join_arms",
            "join_step": {},
        },
    ),
    (
        "upsert_query",
        "operation step",
        {
            "name": "Score it",
            "kind": "operation",
            "operation": "create",
            "node_label": "STEP",
            "attributive_label": "score_it",
            "operation_step": {
                "name": "passed",
                "collision": "overwrite",
                "group_junction": "AND",
                "groups": [
                    {
                        "statement_junction": "AND",
                        "statements": [
                            {"x": "$count", "operator": ">", "y": "1"},
                            {"x": "$ok", "operator": "EXISTS"},
                        ],
                    }
                ],
                "assignments": [
                    {"when": "true", "type": "string", "key": "label", "value": "ok", "collision": "overwrite"},
                    {"when": "false", "type": "boolean", "key": "failed", "value": True},
                    {"when": "always", "type": "number", "key": "tries", "value": 1},
                ],
            },
        },
    ),
    (
        "upsert_query",
        "create instance",
        {
            "name": "Seed person",
            "kind": "operation",
            "operation": "create",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "execute": True,
            "anchor_source": "new",
            "instance_properties": [{"key": "full_name", "value": "Ada"}],
            "hops": [
                {
                    "relationship_label": "person_unit",
                    "target_label": "unit",
                    "target_source": "new",
                    "instance_properties": [{"key": "name", "value": "Ward"}],
                }
            ],
        },
    ),
    (
        "upsert_query",
        "create schema",
        {
            "name": "Create person",
            "kind": "operation",
            "operation": "create",
            "node_label": "SCHEMA",
            "attributive_label": "person",
            "is_vectorized": True,
            "execute": True,
            "schema_properties": _operation_properties(),
        },
    ),
    (
        "upsert_query",
        "update",
        {
            "name": "Set status",
            "kind": "operation",
            "operation": "update",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "where": [{"property_key": "id", "operator": "=", "value": "$id"}],
            "set_expressions": ["n.status = $status"],
        },
    ),
    (
        "upsert_query",
        "delete",
        {
            "name": "Drop person",
            "kind": "operation",
            "operation": "delete",
            "node_label": "INSTANCE",
            "attributive_label": "person",
            "delete_targets": ["n"],
        },
    ),
    (
        "upsert_query",
        "sequence for",
        {
            "id": "ID_seq",
            "name": "Ship it",
            "kind": "sequence",
            "entry_step": "log_shipment",
            "traversal": "downstream",
            "parameters": [{"name": "sku", "value": "A1"}],
            "description": "Shipping",
            "group_title": "Desk",
            "loop": {
                "type": "for",
                "count": 3,
                "max_iterations": 10,
                "delay_seconds": 1,
                "collect": [{"from": "name", "as": "names", "reduce": "list"}],
            },
        },
    ),
    (
        "upsert_query",
        "sequence while",
        {
            "name": "While open",
            "kind": "sequence",
            "entry_step": "log_shipment",
            "traversal": "single",
            "loop": {"type": "for_while", "condition": {"parameter": "open", "operator": "=", "value": "yes"}},
        },
    ),
    (
        "upsert_query",
        "sequence each",
        {
            "name": "Each row",
            "kind": "sequence",
            "entry_step": "log_shipment",
            "loop": {"type": "for_each", "source": "entity_id"},
        },
    ),
    (
        "create_transition",
        "transition",
        {
            "from_step": "log_shipment",
            "to_step": "pack_shipment",
            "relationship_label": "next",
            "condition_type": "parameter",
            "condition": "ok",
            "condition_expected": True,
        },
    ),
    ("update_space", "update space", {"name": "Demo", "endpoint": "https://example.test", "description": "home desk", "dev_mode": True}),
    ("upsert_credential", "credential", {"name": "OPENAI", "description": "chat"}),
    (
        "update_chat_model",
        "chat model",
        {
            "provider": "local_llm",
            "model": "test-model",
            "credential_name": "OPENAI",
            "local_llm_base_url": "http://127.0.0.1:8000",
            "local_llm_config_id": "cfg",
            "max_rounds": 8,
            "role": "planner",
        },
    ),
    (
        "update_embeddings",
        "embeddings",
        {
            "enabled": True,
            "provider": "ollama",
            "ollama_url": "http://127.0.0.1:11434",
            "base_url": "https://generativelanguage.googleapis.com",
            "embed_model": "nomic-embed-text",
            "credential": "OPENAI",
        },
    ),
    ("reindex_embeddings", "reindex", {}),
    ("invite_member", "invite", {"email": "guest@example.com", "role": "Admin"}),
    ("update_member", "member", {"member_id": "ID_member", "role": "Clerk", "is_owner": False}),
    (
        "update_role",
        "role",
        {
            "id": "ID_role",
            "name": "Clerk",
            "permissions": {
                "flows": ["read:STEP"],
                "sequences": {"all": False, "ids": ["ID_seq"]},
                "manage_space": False,
            },
        },
    ),
    ("create_agent_key", "agent key", {"name": "worker", "role": "Clerk"}),
    ("revoke_agent_key", "revoke key", {"id": "ID_key"}),
    ("update_tab_chrome", "tab", {"icon_label": "Pona"}),
    (
        "upsert_event",
        "time event",
        {
            "id": "EV_overdue",
            "name": "Overdue",
            "type": "time",
            "enabled": 1,
            "sequences": ["ID_assign"],
            "recovery_sequences": ["ID_recover"],
            "event_package": {
                "timezone": "America/New_York",
                "combinator": "OR",
                "groups": [
                    {
                        "combinator": "AND",
                        "is_time": "18:00",
                        "is_weekday": [1, 2, 3, 4, 5],
                        "is_month": [11],
                        "is_date_ordinal": [7],
                        "is_year": [2026],
                        "is_date": "2026-11-07",
                    }
                ],
                "parameters": {"n": 1},
            },
        },
    ),
    (
        "upsert_event",
        "external event",
        {
            "name": "Badge-in",
            "type": "external",
            "external_package": {
                "combinator": "AND",
                "filters": [
                    {"path": "event", "operator": "equals", "value": "badge-in"},
                    {"path": "id", "operator": "exists"},
                ],
                "param_mappings": [{"source_path": "event", "parameter": "kind"}],
                "parameters": {"kind": "badge-in"},
            },
        },
    ),
    (
        "upsert_event",
        "simulated event",
        {
            "name": "Generation tick",
            "type": "simulated",
            "simulation_package": {
                "token": "sim-token",
                "tic_unit": "minutes",
                "tic_duration": 15,
                "sequence_id": "ID_tick",
                "console_id": "ID_console",
                "probabilities": [
                    {
                        "id": "PR_week",
                        "name": "Weekly",
                        "description": "ticks forward",
                        "priority": 1,
                        "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
                        "outcomes": [{"id": "OUT_1", "label": "Grow", "weight": "1", "weight_sequence_id": "", "payload": {"note": "hi"}, "payload_mode": "fields"}],
                    },
                    {
                        "name": "On tics",
                        "schedule": {"type": "scheduled", "tics": [1, 5]},
                        "outcomes": [{"label": "Spike", "weight": 2, "payload_mode": "json"}],
                    },
                    {
                        "name": "Sometimes",
                        "schedule": {"type": "random", "every_x": 2, "percent": 40},
                        "outcomes": [{"label": "Skip", "weight": "$weight"}],
                    },
                ],
            },
        },
    ),
    ("delete_event", "delete event", {"id": "EV_1"}),
    (
        "upsert_console",
        "console",
        {
            "id": "ID_console",
            "name": "Desk",
            "trigger_kind": "url",
            "listen_url": "https://example.test/hook",
            "document": {
                "views": [
                    {"id": "live", "name": "Live", "kind": "live", "modules": _console_modules()},
                    {
                        "id": "intake",
                        "name": "Intake",
                        "kind": "form",
                        "dataSequenceId": "read_form",
                        "actionSequenceId": "submit_form",
                        "submitLabel": "Save",
                        "fields": _form_fields(),
                    },
                ],
                "activeViewId": "live",
            },
        },
    ),
    (
        "upsert_console",
        "event console",
        {
            "name": "Nightly",
            "trigger_kind": "event",
            "trigger_event_id": "EV_overdue",
            "document": {"views": [{"id": "live", "name": "Live", "kind": "live", "modules": [_module_sample("table", {"dataPath": ""})]}]},
        },
    ),
    ("delete_console", "delete console", {"id": "ID_console"}),
    ("delete_sequence", "delete sequence", {"id": "ID_seq"}),
    ("delete_operation", "delete operation", {"id": "ID_op"}),
    ("delete_step", "delete step", {"attributive_label": "log_shipment"}),
    ("delete_schema", "delete schema", {"attributive_label": "person"}),
]


def samples() -> list[tuple[str, str, dict[str, Any]]]:
    """Valid payloads. Together they set every field the catalog knows."""
    return [(kind, label, copy.deepcopy(payload)) for kind, label, payload in _SAMPLES]


def uncovered_fields() -> list[str]:
    """Spec paths and module config keys that no valid sample sets."""
    covered: dict[int, set[str]] = {}
    for kind, _label, payload in _SAMPLES:
        spec = spec_for(kind, payload)
        if spec is None:
            continue
        covered.setdefault(id(spec), set()).update(_covered(spec, payload, "payload", ()))
    missing: list[str] = []
    for name, spec in _named_specs():
        have = covered.get(id(spec), set())
        for path in _spec_paths(spec, "payload", ()):
            if path not in have:
                missing.append(f"{name} {path}")
    seen: dict[str, set[str]] = {module_type: set() for module_type in CONFIG}
    for _kind, _label, payload in _SAMPLES:
        document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
        for view in document.get("views") or []:
            if not isinstance(view, dict):
                continue
            for module in view.get("modules") or []:
                if not isinstance(module, dict):
                    continue
                module_type = str(module.get("type") or "")
                config = module.get("config") if isinstance(module.get("config"), dict) else {}
                if module_type in seen:
                    seen[module_type].update(config)
    for module_type, fields in CONFIG.items():
        for key in fields:
            if key not in seen[module_type]:
                missing.append(f"{module_type}.config.{key}")
    return missing


def invalid_probes() -> list[tuple[str, str, list[str]]]:
    """Each field's invalid example, checked against a payload that was valid."""
    found: list[tuple[str, str, list[str]]] = []
    for kind, label, payload in _SAMPLES:
        spec = spec_for(kind, payload)
        if spec is None:
            continue
        for path, node in _concrete(spec, payload, "payload", ()):
            if "invalid" not in node or path == "payload":
                continue
            broken = copy.deepcopy(payload)
            _set_path(broken, path, node["invalid"])
            found.append((label, path, payload_problems(kind, broken)))
        document = payload.get("document") if isinstance(payload.get("document"), dict) else None
        if not isinstance(document, dict):
            continue
        for view_index, view in enumerate(document.get("views") or []):
            if not isinstance(view, dict):
                continue
            for module_index, module in enumerate(view.get("modules") or []):
                if not isinstance(module, dict):
                    continue
                module_type = str(module.get("type") or "")
                config = module.get("config") if isinstance(module.get("config"), dict) else {}
                for key, node in CONFIG.get(module_type, {}).items():
                    if key not in config or "invalid" not in node:
                        continue
                    concrete = f"payload.document.views[{view_index}].modules[{module_index}].config.{key}"
                    broken = copy.deepcopy(payload)
                    _set_path(broken, concrete, node["invalid"])
                    found.append((label, concrete, payload_problems(kind, broken)))
    return found


def unknown_key_probes() -> list[tuple[str, str, list[str]]]:
    """Every object rejects a key it does not list."""
    found: list[tuple[str, str, list[str]]] = []
    for kind, label, payload in _SAMPLES:
        spec = spec_for(kind, payload)
        if spec is None:
            continue
        for path, node in _concrete(spec, payload, "payload", ()):
            if node.get("type") != "object" or node.get("allow_unknown"):
                continue
            broken = copy.deepcopy(payload)
            target = _get_path(broken, path)
            if not isinstance(target, dict):
                continue
            target["not_a_field"] = True
            found.append((label, path, payload_problems(kind, broken)))
        document = payload.get("document") if isinstance(payload.get("document"), dict) else None
        if not isinstance(document, dict):
            continue
        for view_index, view in enumerate(document.get("views") or []):
            if not isinstance(view, dict):
                continue
            for module_index, module in enumerate(view.get("modules") or []):
                if not isinstance(module, dict) or not isinstance(module.get("config"), dict):
                    continue
                concrete = f"payload.document.views[{view_index}].modules[{module_index}].config"
                broken = copy.deepcopy(payload)
                _get_path(broken, concrete)["not_a_field"] = True
                found.append((label, concrete, payload_problems(kind, broken)))
    return found


_PATH = re.compile(r"\.([^.\[\]]+)|\[(\d+)\]")


def _parts(path: str) -> list[str | int]:
    parts: list[str | int] = []
    for key, index in _PATH.findall(path[len("payload") :]):
        parts.append(key if key else int(index))
    return parts


def _get_path(payload: dict[str, Any], path: str) -> Any:
    current: Any = payload
    for part in _parts(path):
        current = current[part]
    return current


def _set_path(payload: dict[str, Any], path: str, value: Any) -> None:
    parts = _parts(path)
    current: Any = payload
    for part in parts[:-1]:
        current = current[part]
    current[parts[-1]] = value
