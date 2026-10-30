"""What a console module would show, or which sequence it would run.

The console draws a module from its data sequence, and shows the expected-shape
note when that result does not fit. Action modules run a different sequence on
submit, and this check names that sequence without executing it. The rules match
the module views: a stat can use one number from a single row, a table uses the
rows, a graph uses nodes, and a form does not load a data sequence that is the
same as its submit sequence.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable

from fastapi.exceptions import HTTPException

from . import auth, catalog, console_service
from .auth import Principal
from .console_service import ConsoleRunError

_DISPLAY = {
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
}
_ACTION = {"button", "switch", "checkbox", "segmented", "select", "number", "form"}
_CHARTS = {"line", "bar", "area"}

Execute = Callable[[dict[str, Any], str], dict[str, Any]]
Resolve = Callable[[str], dict[str, Any] | None]


def check_document(
    space_id: str,
    document: dict[str, Any] | None,
    *,
    principal: Principal | None = None,
    console_id: str = "check",
    defer_missing: bool = False,
    execute: Execute | None = None,
    resolve: Resolve | None = None,
) -> dict[str, Any]:
    """One report per module and form view. ``ok`` is false when one would show the shape note or has no sequence to run."""
    source = catalog._normalize_console_document(document if isinstance(document, dict) else {})
    resolve_fn = resolve or _resolve
    if resolve is None:
        source = console_service.link_console_document(source)
    else:
        source = _link_document(source, resolve_fn)
    run = execute or _execute_data(space_id, principal, console_id)
    reports: list[dict[str, Any]] = []
    views = source.get("views") if isinstance(source.get("views"), list) else []
    for view in views:
        if not isinstance(view, dict):
            continue
        view_id = str(view.get("id") or "")
        if view.get("kind") == "form":
            reports.append(
                _check_form_view(view, view_id, run, resolve_fn, defer_missing)
            )
            continue
        modules = view.get("modules") if isinstance(view.get("modules"), list) else []
        for module in modules:
            if isinstance(module, dict):
                reports.append(
                    _check_module(module, view_id, run, resolve_fn, defer_missing)
                )
    return _summarize(reports)


def describe_module(module_type: str, data: Any, config: dict[str, Any] | None, *, loaded: bool) -> tuple[bool, str]:
    """Whether this module would draw ``data``, and the sentence the agent should trust."""
    kind = (module_type or "").strip()
    settings = config if isinstance(config, dict) else {}
    path = _config_string(settings, "dataPath")
    shown = _pick_path(data, path) if path else data
    if path and shown is None and loaded:
        return False, f"dataPath {path!r} is not in the result. {_sample(data)}"
    if kind == "stat":
        return _describe_stat(shown, loaded)
    if kind == "text":
        return _describe_text(shown, loaded)
    if kind == "table":
        return _describe_table(shown, loaded)
    if kind == "badge":
        return _describe_badge(shown, loaded)
    if kind in ("progress", "ring"):
        return _describe_meter(shown, loaded, kind)
    if kind == "graph":
        return _describe_graph(shown, loaded)
    if kind in _CHARTS:
        return _describe_chart(shown, settings, loaded)
    if kind == "donut":
        return _describe_donut(shown, loaded)
    if kind == "alert":
        return _describe_alert(shown, loaded)
    if kind == "button":
        label = _display_text(shown, ["label"]) or _config_string(settings, "label", "Run")
        return True, f"Shows a button labeled {label}."
    if kind in ("switch", "checkbox"):
        label = _record_text(shown, "label") or _config_string(settings, "label", "Enabled" if kind == "switch" else "Checked")
        state = "on" if _bool_value(shown) else "off"
        return True, f"Shows a {kind} labeled {label}, {state}."
    if kind == "segmented":
        options = _options(shown, _config_string(settings, "options", "Day, Week, Month"))
        if not options:
            return False, f"Shows the expected-shape note. {_sample(shown) if loaded else 'No options are set.'}"
        return True, f"Shows segments {', '.join(options)}."
    if kind == "select":
        options = _options(shown, _config_string(settings, "options", ""))
        if not options:
            return False, f"Shows the expected-shape note. {_sample(shown) if loaded else 'No options are set.'}"
        return True, f"Shows a select with {', '.join(options)}."
    if kind == "number":
        label = _config_string(settings, "label", "Value")
        return True, f"Shows a number field labeled {label}."
    if kind == "form":
        return _describe_form(shown, settings, loaded)
    return False, f"Unknown module type {kind or 'blank'}."


def _check_module(
    module: dict[str, Any],
    view_id: str,
    execute: Execute,
    resolve: Resolve,
    defer_missing: bool,
) -> dict[str, Any]:
    module_type = str(module.get("type") or "table").strip() or "table"
    title = str(module.get("title") or module_type)
    config = module.get("config") if isinstance(module.get("config"), dict) else {}
    data_ref = str(module.get("dataSequenceId") or "").strip()
    action_ref = str(module.get("actionSequenceId") or "").strip()
    data_query = resolve(data_ref) if data_ref else None
    action_query = resolve(action_ref) if action_ref else None
    data_missing = bool(data_ref) and data_query is None
    action_missing = bool(action_ref) and action_query is None
    repeats = (
        module.get("dataSource") == "sequence"
        and module.get("actionSource") == "sequence"
        and bool(data_ref)
        and data_ref == action_ref
    )
    runs = _sequence_name(action_query)

    if data_missing and defer_missing and not repeats and module_type in _DISPLAY:
        return _entry(
            module,
            module_type,
            title,
            ok=True,
            deferred=True,
            shows=f"Not checked yet. {data_ref!r} is not in the catalog.",
            data_sequence=_missing_ref(data_ref),
            runs=runs,
        )
    if repeats and module_type in _DISPLAY:
        return _entry(
            module,
            module_type,
            title,
            ok=False,
            deferred=False,
            shows=(
                "The data sequence is the same as the action sequence, so the console does not load it. "
                "This shows the expected-shape note."
            ),
            data_sequence=_sequence_ref(data_query, data_ref),
            runs=runs,
        )

    loaded = False
    data: Any = None
    run_error = ""
    if data_ref and not repeats and data_query is not None and module.get("dataSource") == "sequence":
        loaded, data, run_error = _run(execute, data_query, view_id)
    elif data_missing and not repeats and not defer_missing:
        run_error = f"{data_ref!r} was not found, so this module cannot show it."

    if run_error:
        visual_ok, shows = False, run_error
    elif module_type in _DISPLAY and not loaded:
        if module.get("dataSource") == "url" and str(module.get("dataUrl") or "").strip():
            visual_ok, shows = False, "This module reads a URL, not a sequence, so it was not run."
        else:
            visual_ok, shows = False, "No data sequence is set, so this shows the expected-shape note."
    else:
        visual_ok, shows = describe_module(module_type, data, config, loaded=loaded)

    deferred = False
    if module_type in _ACTION:
        if action_query is not None:
            shows = _join(shows, _run_sentence(module_type, runs))
            ok = visual_ok
        elif action_missing and defer_missing and visual_ok:
            deferred = True
            ok = True
            shows = _join(shows, f"Not checked yet. {action_ref!r} is not in the catalog.")
        elif action_ref:
            ok = False
            shows = _join(shows, f"{action_ref!r} was not found, so this would not run it.")
        else:
            ok = False
            shows = _join(shows, "It does not run a sequence.")
    else:
        ok = visual_ok
        if runs:
            shows = _join(shows, f"Its action runs {runs}.")

    return _entry(
        module,
        module_type,
        title,
        ok=ok,
        deferred=deferred,
        shows=shows,
        data_sequence=_sequence_ref(data_query, data_ref),
        runs=runs,
    )


def _check_form_view(
    view: dict[str, Any],
    view_id: str,
    execute: Execute,
    resolve: Resolve,
    defer_missing: bool,
) -> dict[str, Any]:
    title = str(view.get("name") or "Form")
    names = [
        str(field.get("name")).strip()
        for field in view.get("fields") or []
        if isinstance(field, dict) and str(field.get("name") or "").strip()
    ]
    data_ref = str(view.get("dataSequenceId") or "").strip()
    action_ref = str(view.get("actionSequenceId") or "").strip()
    data_query = resolve(data_ref) if data_ref else None
    action_query = resolve(action_ref) if action_ref else None
    runs = _sequence_name(action_query)
    field_text = f"Shows fields {', '.join(names)}." if names else "Shows a submit button."
    if data_ref and data_query is None and defer_missing:
        return _entry(
            {"id": view_id},
            "form",
            title,
            ok=True,
            deferred=True,
            shows=f"{field_text} Not checked yet. {data_ref!r} is not in the catalog.",
            data_sequence=_missing_ref(data_ref),
            runs=runs,
        )
    info = ""
    problem = ""
    if data_ref and data_query is not None:
        loaded, data, run_error = _run(execute, data_query, view_id)
        if run_error:
            problem = f"Opening it shows an error: {run_error}"
        elif loaded:
            info = _form_fill_note(data, names).strip()
            if info.startswith("The read returned"):
                problem = info
                info = ""
    elif data_ref and data_query is None and not defer_missing:
        problem = f"{data_ref!r} was not found, so this form cannot load it."
    if action_query is None and action_ref and defer_missing and not problem:
        return _entry(
            {"id": view_id},
            "form",
            title,
            ok=True,
            deferred=True,
            shows=_join(field_text, f"Not checked yet. {action_ref!r} is not in the catalog."),
            data_sequence=_sequence_ref(data_query, data_ref),
            runs=None,
        )
    if runs:
        shows = _join(_join(field_text, info), _join(problem, f"Submit runs {runs}."))
        ok = not problem
    elif action_ref:
        shows = _join(_join(field_text, info), _join(problem, f"{action_ref!r} was not found, so submit would not run it."))
        ok = False
    else:
        shows = _join(_join(field_text, info), _join(problem, "Submit does not run a sequence."))
        ok = False
    return _entry(
        {"id": view_id},
        "form",
        title,
        ok=ok,
        deferred=False,
        shows=shows,
        data_sequence=_sequence_ref(data_query, data_ref),
        runs=runs,
    )


def _run(execute: Execute, query: dict[str, Any], view_id: str) -> tuple[bool, Any, str]:
    try:
        outcome = execute(query, view_id)
    except ConsoleRunError as exc:
        return False, None, str(exc)
    except HTTPException as exc:
        return False, None, str(exc.detail)
    except Exception as exc:
        return False, None, str(exc)
    if not isinstance(outcome, dict):
        return False, None, "sequence returned nothing the module can draw"
    status = str(outcome.get("status") or "")
    if status == "pending":
        return False, None, "The data sequence paused for input, so the module shows an error instead of a value."
    if status != "inactive":
        return False, None, f"sequence returned {status or 'an unexpected status'}"
    return True, outcome.get("final_result"), ""


def _execute_data(space_id: str, principal: Principal | None, console_id: str) -> Execute:
    def execute(query: dict[str, Any], view_id: str) -> dict[str, Any]:
        kind = str(query.get("kind") or "")
        sequence_id = str(query.get("id") or "")
        if kind == "sequence" and principal is not None:
            auth.require_sequence_run(principal, space_id, sequence_id)
        return console_service.execute_console_sequence(
            {"id": console_id or "check", "space_id": space_id},
            sequence_id,
            view_id,
            "data",
            {"console_id": console_id, "view_id": view_id},
            principal.user_id if principal is not None else None,
        )

    return execute


def _resolve(ref: str) -> dict[str, Any] | None:
    token = (ref or "").strip()
    if not token:
        return None
    try:
        return console_service.resolve_console_target(token)
    except ConsoleRunError:
        return None


def _link_document(document: dict[str, Any], resolve: Resolve) -> dict[str, Any]:
    """Same data-sequence fill as the console, using the injected resolver so a test does not need the catalog."""
    views = document.get("views")
    if not isinstance(views, list):
        return document
    next_views = []
    for view in views:
        if not isinstance(view, dict) or not isinstance(view.get("modules"), list):
            next_views.append(view)
            continue
        modules = []
        for module in view["modules"]:
            if isinstance(module, dict):
                modules.append(_link_module(module, resolve))
            else:
                modules.append(module)
        next_views.append({**view, "modules": modules})
    return {**document, "views": next_views}


def _link_module(module: dict[str, Any], resolve: Resolve) -> dict[str, Any]:
    data_ref = _first_text(module, ("dataSequenceId", "data_sequence_id", "sequenceId", "sequence_id"))
    action_ref = _first_text(module, ("actionSequenceId", "action_sequence_id"))
    data_id = _resolved_id(data_ref, resolve)
    action_id = _resolved_id(action_ref, resolve)
    module_type = str(module.get("type") or "")
    if not data_id and action_id and (module_type == "form" or module.get("dataSource") == "sequence"):
        data_id = action_id
    linked = dict(module)
    if data_id:
        linked["dataSequenceId"] = data_id
        linked["dataSource"] = "sequence"
    if action_id:
        linked["actionSequenceId"] = action_id
        linked["actionSource"] = "sequence"
    return linked


def _resolved_id(ref: str, resolve: Resolve) -> str:
    token = (ref or "").strip()
    if not token:
        return ""
    query = resolve(token)
    if not query:
        return token
    kind = str(query.get("kind") or "")
    if kind in ("sequence", "operation"):
        return str(query.get("id") or "")
    return ""


def _summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    bad = [item for item in reports if not item["ok"]]
    if bad:
        summary = " ".join(f"{item['title']} ({item['type']}) is not ok. {item['shows']}" for item in bad)
        return {"ok": False, "summary": summary, "modules": reports}
    deferred = [item for item in reports if item.get("deferred")]
    if deferred:
        names = ", ".join(str(item["title"]) for item in deferred)
        summary = f"Not checked yet, because a sequence is not in the catalog: {names}."
        return {"ok": True, "summary": summary, "modules": reports}
    if reports:
        return {
            "ok": True,
            "summary": "Every module would show its data or names the sequence it runs.",
            "modules": reports,
        }
    return {
        "ok": False,
        "summary": "The console has no modules. Do not describe module results.",
        "modules": reports,
    }


def _entry(
    module: dict[str, Any],
    module_type: str,
    title: str,
    *,
    ok: bool,
    deferred: bool,
    shows: str,
    data_sequence: dict[str, Any] | None,
    runs: str | None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": str(module.get("id") or ""),
        "type": module_type,
        "title": title,
        "ok": ok,
        "shows": shows,
    }
    if deferred:
        item["deferred"] = True
    if data_sequence:
        item["data_sequence"] = data_sequence
    if runs:
        item["runs"] = runs
    return item


def _sequence_ref(query: dict[str, Any] | None, ref: str) -> dict[str, Any] | None:
    if query:
        return {
            "id": str(query.get("id") or ""),
            "name": str(query.get("name") or ref),
            "kind": str(query.get("kind") or ""),
        }
    if ref:
        return _missing_ref(ref)
    return None


def _missing_ref(ref: str) -> dict[str, Any]:
    return {"name": ref, "missing": True}


def _sequence_name(query: dict[str, Any] | None) -> str | None:
    if not query:
        return None
    return str(query.get("name") or query.get("id") or "") or None


def _run_sentence(module_type: str, runs: str | None) -> str:
    if not runs:
        return "It does not run a sequence."
    if module_type == "form":
        return f"Submit runs {runs}."
    if module_type == "button":
        return f"Pressing it runs {runs}."
    return f"Changing it runs {runs}."


def _join(left: str, right: str) -> str:
    left = left.strip()
    right = right.strip()
    if not left:
        return right
    if not right:
        return left
    if left.endswith("."):
        return f"{left} {right}"
    return f"{left}. {right}"


def _describe_stat(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    value = _display_text(data, ["value"])
    label = _record_text(data, "label")
    if value is None:
        numbers = [line for line in _sequence_lines(data) if line[2]]
        if len(numbers) != 1:
            hint = " A table would show these columns." if len(numbers) > 1 else ""
            text_lines = _sequence_lines(data)
            if not numbers and text_lines:
                hint = " A text module would show these fields."
            return False, f"Shows the expected-shape note. {_sample(data)} A stat needs one number.{hint}"
        value = numbers[0][1]
        label = label or numbers[0][0]
    shown = f"Shows {value}" + (f", labeled {label}." if label else ".")
    return True, shown


def _describe_text(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    text = _module_text(data, ["text", "message", "body"])
    if text is not None:
        return True, f"Shows {_short(text)}."
    lines = _sequence_lines(data)
    if not lines:
        return False, f"Shows the expected-shape note. {_sample(data)}"
    body = ", ".join(f"{key}: {value}" for key, value, _numeric in lines[:6])
    return True, f"Shows {body}."


def _describe_table(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    model = _table_model(data)
    if model is None:
        return False, f"Shows the expected-shape note. {_sample(data)}"
    columns, rows = model
    if not columns:
        return True, "Shows no rows."
    preview = ""
    if rows:
        bits = [f"{key}={_short(rows[0].get(key))}" for key in columns[:6]]
        preview = f" First row: {', '.join(bits)}."
    return True, f"Shows {len(rows)} rows: {', '.join(columns[:8])}.{preview}"


def _describe_badge(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    label = _display_text(data, ["label", "text", "status"])
    if label is None:
        hint = " A text module would show these fields." if _sequence_lines(data) else ""
        return False, f"Shows the expected-shape note. {_sample(data)} A badge needs a label, text, or status.{hint}"
    return True, f"Shows a badge {label}."


def _describe_meter(data: Any, loaded: bool, kind: str) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    raw = _top_number(data, "value")
    if raw is None:
        numbers = [line for line in _sequence_lines(data) if line[2]]
        hint = f" A stat would show {numbers[0][0]}." if len(numbers) == 1 else ""
        return False, (
            f"Shows the expected-shape note. {_sample(data)} "
            f"A {kind} needs a top-level value from 0 to 100.{hint}"
        )
    shown = max(0, min(100, raw))
    label = _record_text(data, "label")
    text = f"Shows { _num(shown) }%"
    if shown != raw:
        text += f" ({_num(raw)} clamped to 0–100)"
    if label:
        text += f", labeled {label}"
    return True, text + "."


def _describe_graph(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    graph = _graph_payload(data)
    if graph is None:
        return False, f"Shows the expected-shape note. {_sample(data)} A graph needs nodes."
    nodes = graph["nodes"]
    rels = graph["relationships"]
    if not nodes:
        return True, "Shows no nodes."
    labels = ", ".join(_node_label(node) for node in nodes[:4])
    return True, f"Shows {len(nodes)} nodes ({labels}) and {len(rels)} relationships."


def _describe_chart(data: Any, config: dict[str, Any], loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    rows = _chart_rows(data)
    if rows is None:
        return False, f"Shows the expected-shape note. {_sample(data)} A chart needs a list of objects."
    if not rows:
        return True, "Shows an empty chart."
    category = _config_string(config, "categoryKey", "name")
    value_key = _config_string(config, "valueKey", "value")
    columns = list(rows[0].keys())
    if not any(_is_number(row.get(value_key)) for row in rows):
        return False, (
            f"The chart would be empty. valueKey {value_key!r} is not a number. "
            f"Rows have {', '.join(columns[:8])}. Set valueKey to a numeric column."
        )
    if not any(category in row for row in rows):
        return False, (
            f"The chart has no labels. categoryKey {category!r} is not in the rows "
            f"({', '.join(columns[:8])}). Set categoryKey to the label column."
        )
    return True, f"Shows {len(rows)} points, {category} by {value_key}."


def _describe_donut(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    rows = _chart_rows(data)
    if not rows or not any(_is_number(row.get("value")) for row in rows):
        columns = list(rows[0].keys()) if rows else []
        extra = f" Rows have {', '.join(columns[:8])}." if columns else ""
        return False, f"Shows the expected-shape note. {_sample(data)} A donut needs name and value.{extra}"
    names = [str(row.get("name") or "slice") for row in rows if _is_number(row.get("value"))]
    return True, f"Shows {len(names)} slices ({', '.join(names[:6])})."


def _describe_alert(data: Any, loaded: bool) -> tuple[bool, str]:
    if not loaded:
        return False, "No data sequence is set, so this shows the expected-shape note."
    message = _display_text(data, ["message", "text", "body"])
    if message is None:
        hint = " A text module would show these fields." if _sequence_lines(data) else ""
        return False, f"Shows the expected-shape note. {_sample(data)} An alert needs a message.{hint}"
    title = _record_text(data, "title")
    text = f"Shows an alert: {_short(message)}"
    if title:
        text += f" ({title})"
    return True, text + "."


def _describe_form(data: Any, config: dict[str, Any], loaded: bool) -> tuple[bool, str]:
    names, error = _form_field_names(config.get("fields"))
    if error:
        return False, f"Shows the expected-shape note. {error}"
    if not names:
        return True, "Shows a submit button."
    note = _form_fill_note(data, names).strip() if loaded else ""
    if note.startswith("The read returned"):
        return False, f"Shows fields {', '.join(names)}. {note}"
    if note:
        return True, f"Shows fields {', '.join(names)}. {note}"
    return True, f"Shows fields {', '.join(names)}."


def _form_fill_note(data: Any, names: list[str]) -> str:
    if not names or not isinstance(data, dict):
        return ""
    if isinstance(data.get("values"), dict):
        source = data["values"]
    elif isinstance(data.get("rows"), list):
        row = data["rows"][0] if len(data["rows"]) == 1 and isinstance(data["rows"][0], dict) else None
        matched = [name for name in names if row and name in row]
        if matched:
            return (
                f" The read returned {', '.join(matched)} on a row, but this form reads top-level values, "
                "so those fields stay blank."
            )
        return ""
    else:
        source = data
    filled = [name for name in names if name in source and source.get(name) not in (None, "")]
    if filled:
        return f" Filled from the read: {', '.join(filled)}."
    return ""


def _form_field_names(raw: Any) -> tuple[list[str], str | None]:
    if isinstance(raw, str):
        if not raw.strip():
            return [], None
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return [], "Fields JSON could not be parsed."
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return [], "Fields must be a JSON array."
    names = [
        str(entry.get("name")).strip()
        for entry in raw
        if isinstance(entry, dict) and str(entry.get("name") or "").strip()
    ]
    return names, None


def _sample(data: Any) -> str:
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        rows = data["rows"]
        if not rows:
            return "The sequence returned no rows."
        first = rows[0]
        if isinstance(first, dict):
            bits = [f"{key}={_short(first.get(key))}" for key in list(first.keys())[:6]]
            extra = f" ({len(rows)} rows)" if len(rows) != 1 else ""
            return f"The sequence returned {', '.join(bits)}{extra}."
    if isinstance(data, dict) and isinstance(data.get("graph"), dict):
        nodes = data["graph"].get("nodes") if isinstance(data["graph"].get("nodes"), list) else []
        return f"The sequence returned {len(nodes)} nodes."
    if isinstance(data, list) and data and isinstance(data[0], dict):
        bits = [f"{key}={_short(data[0].get(key))}" for key in list(data[0].keys())[:6]]
        return f"The sequence returned {', '.join(bits)} ({len(data)} rows)."
    if data is None:
        return "The sequence returned nothing."
    return "The sequence result does not match this module."


def _table_model(data: Any) -> tuple[list[str], list[dict[str, Any]]] | None:
    if isinstance(data, list):
        if not all(isinstance(row, dict) for row in data):
            return None
        columns = list(data[0].keys()) if data else []
        return columns, data
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        return None
    rows = data["rows"]
    if not all(isinstance(row, dict) for row in rows):
        return None
    if isinstance(data.get("columns"), list):
        columns = [str(column) for column in data["columns"]]
    else:
        columns = list(rows[0].keys()) if rows else []
    return columns, rows


def _chart_rows(data: Any) -> list[dict[str, Any]] | None:
    if isinstance(data, list):
        source = data
    elif isinstance(data, dict) and isinstance(data.get("rows"), list):
        source = data["rows"]
    elif isinstance(data, dict) and isinstance(data.get("data"), list):
        source = data["data"]
    else:
        return None
    if not all(isinstance(row, dict) for row in source):
        return None
    return source


def _graph_payload(data: Any) -> dict[str, Any] | None:
    source = _graph_record(data)
    if source is None or not isinstance(source.get("nodes"), list):
        return None
    rel_source = source.get("relationships") if "relationships" in source else source.get("edges")
    if rel_source is not None and not isinstance(rel_source, list):
        return None
    nodes = []
    seen: set[str] = set()
    for item in source["nodes"]:
        if not isinstance(item, dict):
            return None
        element_id = _field(item, ("element_id", "elementId", "id"))
        if not element_id or element_id in seen:
            if not element_id:
                return None
            continue
        seen.add(element_id)
        nodes.append(item)
    relationships = []
    for item in rel_source or []:
        if not isinstance(item, dict):
            return None
        start = _field(item, ("start", "source", "from"))
        end = _field(item, ("end", "target", "to"))
        if start and end:
            relationships.append(item)
    return {"nodes": nodes, "relationships": relationships}


def _graph_record(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    if data.get("kind") in ("table", "response", "summary"):
        return None
    graph = data.get("graph")
    if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
        return graph
    if isinstance(data.get("nodes"), list):
        return data
    return None


def _node_label(node: dict[str, Any]) -> str:
    label = _field(node, ("display_label", "displayLabel", "label", "name", "attributive_label"))
    if label:
        return label
    properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
    return _field(properties, ("display_label", "name", "attributive_label")) or _field(node, ("id", "element_id")) or "node"


def _sequence_lines(data: Any) -> list[tuple[str, str, bool]]:
    if not isinstance(data, dict):
        return []
    rows = data.get("rows")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        return []
    lines = []
    for key, value in rows[0].items():
        if isinstance(value, bool):
            lines.append((key, "true" if value else "false", False))
        elif _is_number(value):
            lines.append((key, _num(value), True))
        elif isinstance(value, str):
            lines.append((key, value, False))
        elif isinstance(value, list):
            lines.append((key, f"{len(value)} items", False))
    return lines


def _module_text(data: Any, keys: list[str]) -> str | None:
    direct = _display_text(data, keys)
    if direct is not None:
        return direct
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list) or len(data["rows"]) != 1:
        return None
    return _display_text(data["rows"][0], keys)


def _display_text(data: Any, keys: list[str]) -> str | None:
    if isinstance(data, str):
        return data
    if _is_number(data):
        return _num(data)
    if not isinstance(data, dict):
        return None
    for key in keys:
        value = data.get(key)
        if isinstance(value, str):
            return value
        if _is_number(value):
            return _num(value)
    return None


def _record_text(data: Any, key: str) -> str | None:
    if isinstance(data, dict):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _bool_value(data: Any) -> bool:
    if isinstance(data, bool):
        return data
    if isinstance(data, dict) and isinstance(data.get("value"), bool):
        return data["value"]
    return False


def _options(data: Any, fallback: str) -> list[str]:
    if isinstance(data, dict) and isinstance(data.get("options"), list):
        found = []
        for option in data["options"]:
            if isinstance(option, str) and option:
                found.append(option)
            elif isinstance(option, dict) and isinstance(option.get("value"), str) and option["value"]:
                found.append(option["value"])
        if found:
            return found
    return [part.strip() for part in fallback.split(",") if part.strip()]


def _top_number(data: Any, key: str) -> float | None:
    if not isinstance(data, dict):
        return None
    return _as_number(data.get(key))


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or not _is_number(value):
        if isinstance(value, str) and value.strip():
            try:
                number = float(value)
            except ValueError:
                return None
            if math.isfinite(number):
                return number
        return None
    return float(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _num(value: Any) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return str(number)


def _pick_path(data: Any, path: str) -> Any:
    current = data
    for key in path.split("."):
        if isinstance(current, dict):
            if key not in current:
                return None
            current = current[key]
        elif isinstance(current, list) and key.isdigit():
            index = int(key)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _config_string(config: dict[str, Any], key: str, fallback: str = "") -> str:
    value = config.get(key)
    return value if isinstance(value, str) else fallback


def _field(record: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if _is_number(value):
            return _num(value)
    return None


def _first_text(source: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _short(value: Any) -> str:
    text = "" if value is None else str(value)
    if len(text) > 40:
        return text[:37] + "..."
    return text
