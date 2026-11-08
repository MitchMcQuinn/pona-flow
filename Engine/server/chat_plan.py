"""Consultation brief, readiness, assumptions, and the compile step into a change batch.

The model revises the brief. This module decides which unrequested features are
assumed, when the brief is ready, and which propose_change items that brief becomes.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from . import chat_apply, cypher_utils

_SOURCES = ("person", "clock", "external", "simulated", "seed")
_LANDINGS = {
    "person": "console",
    "clock": "time_event",
    "external": "external_event",
    "simulated": "simulated_event",
    "seed": "execute_package",
}
_SIMULATED_LANDINGS = {"simulated_event", "console"}
_TIC_UNITS = {"seconds", "minutes", "hours", "days"}
_STRUCTURAL = (
    "routine",
    "reconstruction",
    "ontology",
    "multi_hop",
    "outputs",
    "operations",
    "screens",
    "vector",
)
_INSTANCE_OPERATIONS = ("list", "read", "create", "update", "delete")
_SCREEN_MODULES = ("table", "form", "graph", "stat", "text", "number", "button")
_ACTION_MODULES = frozenset({"number", "button", "form"})
ALREADY_CONFIGURED = "This space is already configured to meet this. What are you looking to add?"
_NAME_BLOCKS = frozenset({"names", "configured"})
_BUILD_KINDS = {
    "upsert_schema",
    "upsert_query",
    "create_transition",
    "upsert_event",
    "upsert_console",
}


def empty_brief() -> dict[str, Any]:
    return {
        "routine": "",
        "reconstruction": {"avoids_runtime_guess": False, "because": ""},
        "ontology": {"types": [], "links": []},
        "multi_hop": {"needed": False, "path": [], "why": ""},
        "inputs": [],
        "outputs": [],
        "operations": [],
        "screens": [],
        "vector": {"used": False, "only_to_name_the_subject": False, "text": ""},
        "assumptions": [],
        "rejected": [],
        "open_questions": [],
        "status": "consulting",
    }


def _label(value: Any) -> str:
    return cypher_utils.normalize_attributive_label(str(value or ""))


def _text(value: Any, limit: int = 400) -> str:
    return str(value or "").strip()[:limit]


def _properties(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    properties: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        key = _label(entry.get("key") or entry.get("name"))
        if not key or key in seen or key == "id":
            continue
        seen.add(key)
        value_type = str(entry.get("value_type") or "string").strip() or "string"
        properties.append({"key": key, "value_type": value_type})
    return properties


def _types(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    types: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        label = _label(entry.get("label") or entry.get("attributive_label"))
        if not label or label in seen:
            continue
        seen.add(label)
        label_property = _label(entry.get("label_property") or "name") or "name"
        properties = _properties(entry.get("properties"))
        if not any(prop["key"] == label_property for prop in properties):
            properties.insert(0, {"key": label_property, "value_type": "string"})
        types.append({"label": label, "label_property": label_property, "properties": properties})
    return types


def _links(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    links: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        origin = _label(entry.get("from"))
        target = _label(entry.get("to"))
        label = _label(entry.get("label") or f"{origin}_{target}")
        if not origin or not target or not label or origin == target:
            continue
        key = (origin, target, label)
        if key in seen:
            continue
        seen.add(key)
        links.append(
            {
                "from": origin,
                "to": target,
                "label": label,
                "infers": _text(entry.get("infers") or f"{target} reached from {origin}", 240),
            }
        )
    return links


def _situations(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    situations: list[dict[str, Any]] = []
    for entry in raw:
        if isinstance(entry, str) and entry.strip():
            situations.append({"name": _text(entry, 80), "parameters": {}})
            continue
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name") or entry.get("label"), 80)
        if not name:
            continue
        parameters = entry.get("parameters") if isinstance(entry.get("parameters"), dict) else {}
        situations.append(
            {
                "name": name,
                "parameters": {str(key): _text(value, 80) for key, value in parameters.items() if str(key).strip()},
            }
        )
    return situations


def _simulation(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    unit = str(raw.get("tic_unit") or "").strip().lower()
    try:
        duration = int(raw.get("tic_duration") or 1)
    except (TypeError, ValueError):
        duration = 1
    return {
        "tic_unit": unit if unit in _TIC_UNITS else "",
        "tic_duration": duration if duration >= 1 else 1,
        "situations": _situations(raw.get("situations")),
    }


def _inputs(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    inputs: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name"), 120)
        source = str(entry.get("source") or "").strip().lower()
        lands = str(entry.get("lands_as") or "").strip().lower()
        if source not in _SOURCES:
            continue
        if not name:
            continue
        if source == "simulated":
            if lands not in _SIMULATED_LANDINGS:
                lands = "simulated_event"
        elif lands != _LANDINGS[source]:
            lands = _LANDINGS[source]
        live = entry.get("live")
        inputs.append(
            {
                "name": name,
                "source": source,
                "lands_as": lands,
                "confirmed": entry.get("confirmed") is True,
                "live": live if isinstance(live, bool) else None,
                "simulation": _simulation(entry.get("simulation")),
            }
        )
    return inputs


def _branch(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    parameter = _label(raw.get("parameter"))
    when_true = _text(raw.get("when_true"), 80)
    when_false = _text(raw.get("when_false"), 80)
    if not parameter or not when_true or not when_false:
        return None
    return {"parameter": parameter, "when_true": when_true, "when_false": when_false}


def _outputs(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    outputs: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name"), 120)
        if not name:
            continue
        kind = str(entry.get("kind") or "single").strip().lower()
        results = [_text(item, 80) for item in entry.get("results") or [] if _text(item, 80)]
        reads = [_label(item) for item in entry.get("reads") or [] if _label(item)]
        writes = [_label(item) for item in entry.get("writes") or [] if _label(item)]
        outputs.append(
            {
                "name": name,
                "kind": "chain" if kind == "chain" else "single",
                "starts_at": _label(entry.get("starts_at")),
                "reads": reads,
                "writes": writes,
                "results": results,
                "branch": _branch(entry.get("branch")),
            }
        )
    return outputs


def _operation_ref(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in _INSTANCE_OPERATIONS:
        return text
    return _label(text)


def _operations(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    operations: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        label = _label(entry.get("type") or entry.get("label"))
        operation = str(entry.get("operation") or "").strip().lower()
        if not label or operation not in _INSTANCE_OPERATIONS:
            continue
        key = (label, operation)
        if key in seen:
            continue
        seen.add(key)
        operations.append({"type": label, "operation": operation})
    return operations


def _screens(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    screens: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = _text(entry.get("name"), 120)
        if not name or name in seen:
            continue
        views: list[dict[str, str]] = []
        for view in entry.get("views") or []:
            if not isinstance(view, dict):
                continue
            module = str(view.get("module") or "").strip().lower()
            if module not in _SCREEN_MODULES:
                continue
            subject = _label(view.get("subject"))
            views.append(
                {
                    "name": _text(view.get("name") or subject or module, 80),
                    "module": module,
                    "subject": subject,
                    "data": _operation_ref(view.get("data")),
                    "action": _operation_ref(view.get("action")),
                }
            )
        if not views:
            continue
        seen.add(name)
        screens.append({"name": name, "views": views})
    return screens


def _questions(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    questions: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        question = _text(entry.get("question"), 300)
        if not question:
            continue
        questions.append(
            {
                "id": _text(entry.get("id") or question, 80),
                "question": question,
                "blocks": _text(entry.get("blocks"), 80),
            }
        )
    return questions


def _assumptions(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    assumptions: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        ident = _text(entry.get("id"), 80)
        adds = _text(entry.get("adds"), 240)
        if not ident or not adds or ident in seen:
            continue
        seen.add(ident)
        assumptions.append({"id": ident, "adds": adds, "because": _text(entry.get("because"), 240)})
    return assumptions


def normalize_brief(raw: Any) -> dict[str, Any]:
    """Coerce a model payload into the brief. Unknown sections are dropped."""
    source = raw if isinstance(raw, dict) else {}
    if isinstance(source.get("brief"), dict):
        source = source["brief"]
    base = empty_brief()
    base["routine"] = _text(source.get("routine"), 400)
    reconstruction = source.get("reconstruction") if isinstance(source.get("reconstruction"), dict) else {}
    base["reconstruction"] = {
        "avoids_runtime_guess": reconstruction.get("avoids_runtime_guess") is True,
        "because": _text(reconstruction.get("because"), 400),
    }
    ontology = source.get("ontology") if isinstance(source.get("ontology"), dict) else {}
    base["ontology"] = {"types": _types(ontology.get("types")), "links": _links(ontology.get("links"))}
    hop = source.get("multi_hop") if isinstance(source.get("multi_hop"), dict) else {}
    base["multi_hop"] = {
        "needed": hop.get("needed") is True,
        "path": [_label(item) for item in hop.get("path") or [] if _label(item)],
        "why": _text(hop.get("why"), 400),
    }
    base["inputs"] = _inputs(source.get("inputs"))
    base["outputs"] = _outputs(source.get("outputs"))
    base["operations"] = _operations(source.get("operations"))
    base["screens"] = _screens(source.get("screens"))
    vector = source.get("vector") if isinstance(source.get("vector"), dict) else {}
    base["vector"] = {
        "used": vector.get("used") is True,
        "only_to_name_the_subject": vector.get("only_to_name_the_subject") is True,
        "text": _text(vector.get("text"), 240),
    }
    base["assumptions"] = _assumptions(source.get("assumptions"))
    rejected = source.get("rejected") if isinstance(source.get("rejected"), list) else []
    base["rejected"] = [str(item) for item in rejected if str(item).strip()]
    base["open_questions"] = _questions(source.get("open_questions"))
    status = str(source.get("status") or "consulting").strip().lower()
    base["status"] = "confirmed" if status == "confirmed" else "consulting"
    return base


def _section(brief: dict[str, Any], key: str) -> Any:
    if key == "routine":
        return brief.get("routine") or ""
    if key == "reconstruction":
        return dict(brief.get("reconstruction") or {})
    if key == "ontology":
        return {
            "types": list((brief.get("ontology") or {}).get("types") or []),
            "links": list((brief.get("ontology") or {}).get("links") or []),
        }
    if key == "multi_hop":
        return dict(brief.get("multi_hop") or {})
    if key == "outputs":
        return list(brief.get("outputs") or [])
    if key == "operations":
        return list(brief.get("operations") or [])
    if key == "screens":
        return list(brief.get("screens") or [])
    if key == "vector":
        return dict(brief.get("vector") or {})
    return None


def _structural_changed(current: dict[str, Any], incoming: dict[str, Any]) -> bool:
    probe = normalize_brief(incoming)
    for key in _STRUCTURAL:
        if key not in incoming:
            continue
        if _section(probe, key) != _section(current, key):
            return True
    return False


def _surface_slots_changed(before: dict[str, Any], after: dict[str, Any]) -> bool:
    """True when a surface update confirmed an input, described a simulation, or dropped an assumption."""
    return any(before.get(key) != after.get(key) for key in ("inputs", "assumptions", "rejected"))


def _adopt_type(
    brief: dict[str, Any], types: list[dict[str, Any]], labels: list[str], label: str, because: str
) -> None:
    """Register a record kind the plan already uses. A rejected kind stays out."""
    if not label or label in labels or f"type:{label}" in brief["rejected"]:
        return
    types.append(_blank_type(label))
    labels.append(label)
    _assume(brief, f"type:{label}", f"Record kind {label}.", because)


def _blank_type(label: str) -> dict[str, Any]:
    return {
        "label": label,
        "label_property": "name",
        "properties": [{"key": "name", "value_type": "string"}],
    }


def _rejected_type_labels(brief: dict[str, Any]) -> set[str]:
    labels: set[str] = set()
    for ident in brief.get("rejected") or []:
        if not isinstance(ident, str) or not ident.startswith("type:"):
            continue
        label = ident.split(":", 1)[1]
        if label:
            labels.add(label)
    return labels


def _assume(brief: dict[str, Any], ident: str, adds: str, because: str) -> None:
    if ident in brief["rejected"]:
        return
    if any(item["id"] == ident for item in brief["assumptions"]):
        return
    brief["assumptions"].append({"id": ident, "adds": adds, "because": because})


def _link_between(links: list[dict[str, str]], origin: str, target: str) -> dict[str, str] | None:
    for link in links:
        if link["from"] == origin and link["to"] == target:
            return link
    return None


def apply_assumptions(brief: dict[str, Any]) -> dict[str, Any]:
    """Add the features the brief already implies and the model left out."""
    rejected_labels = _rejected_type_labels(brief)
    if rejected_labels:
        brief["ontology"]["types"] = [
            entry for entry in brief["ontology"]["types"] if entry["label"] not in rejected_labels
        ]
        brief["multi_hop"]["path"] = [
            step for step in brief["multi_hop"].get("path") or [] if step not in rejected_labels
        ]
    types = brief["ontology"]["types"]
    links: list[dict[str, str]] = brief["ontology"]["links"]
    hop = brief["multi_hop"]
    labels = [item["label"] for item in types]
    if rejected_labels:
        brief["ontology"]["links"] = [
            link
            for link in links
            if link.get("from") not in rejected_labels and link.get("to") not in rejected_labels
        ]
        links = brief["ontology"]["links"]
        brief["operations"] = [
            entry for entry in brief["operations"] if entry["type"] not in rejected_labels
        ]
        for screen in brief["screens"]:
            screen["views"] = [
                view for view in screen.get("views") or [] if view.get("subject") not in rejected_labels
            ]
        brief["screens"] = [screen for screen in brief["screens"] if screen.get("views")]
    for label in list(hop.get("path") or []):
        _adopt_type(brief, types, labels, label, "The path names it.")
    for link in links:
        _adopt_type(brief, types, labels, link.get("from") or "", "A link uses it.")
        _adopt_type(brief, types, labels, link.get("to") or "", "A link uses it.")
    for entry in brief["operations"]:
        _adopt_type(brief, types, labels, entry["type"], "An operation uses it.")
    for screen in brief["screens"]:
        for view in screen.get("views") or []:
            _adopt_type(brief, types, labels, view.get("subject") or "", "A screen uses it.")
    because = str(brief["reconstruction"].get("because") or "")
    mentions_related = any(label != labels[0] and label in because.lower() for label in labels) if labels else False
    # A link is the relationship itself. It becomes a decision hop only when the
    # plan already says the decision reads that link.
    if len(labels) >= 2 and (hop["needed"] or mentions_related):
        if not hop["needed"] and "hop" not in brief["rejected"]:
            hop["needed"] = True
            hop["path"] = hop["path"] or labels
            hop["why"] = hop["why"] or because or "The deciding fact is on a related record."
            _assume(
                brief,
                "hop",
                "Load the related records before deciding.",
                "The deciding fact is not on the subject.",
            )
        path = hop["path"] or labels
        for origin, target in zip(path, path[1:]):
            if origin not in labels or target not in labels:
                continue
            if _link_between(links, origin, target):
                continue
            ident = f"link:{origin}:{target}"
            if ident in brief["rejected"]:
                continue
            links.append(
                {
                    "from": origin,
                    "to": target,
                    "label": f"{origin}_{target}",
                    "infers": f"{target} reached from {origin}",
                }
            )
            _assume(brief, ident, f"Link {origin} to {target}.", f"The path uses {target}.")
        if brief["outputs"] and hop["needed"]:
            brief["outputs"][0]["reads"] = list(path)
            if len(path) >= 2:
                brief["outputs"][0]["kind"] = "chain"

    for output in brief["outputs"]:
        results = list(output.get("results") or [])
        if len(results) >= 2 and not output.get("branch"):
            ident = f"branch:{_label(output['name']) or 'decision'}"
            if ident in brief["rejected"]:
                continue
            parameter = _label(output["name"]) or "decision"
            output["branch"] = {
                "parameter": parameter,
                "when_true": results[0],
                "when_false": results[1],
            }
            output["kind"] = "chain"
            _assume(brief, ident, f"Branch on {parameter}.", "Two results need a guarded transition.")

    situations: list[str] = []
    for entry in brief["inputs"]:
        simulation = entry.get("simulation") or {}
        for situation in simulation.get("situations") or []:
            if situation.get("name"):
                situations.append(situation["name"])
    if len(situations) >= 2 and brief["outputs"] and not brief["outputs"][0].get("branch"):
        ident = f"branch:{_label(brief['outputs'][0]['name']) or 'decision'}"
        if ident not in brief["rejected"]:
            parameter = _label(brief["outputs"][0]["name"]) or "decision"
            brief["outputs"][0]["branch"] = {
                "parameter": parameter,
                "when_true": situations[0],
                "when_false": situations[1],
            }
            brief["outputs"][0]["kind"] = "chain"
            brief["outputs"][0]["results"] = situations[:2]
            _assume(brief, ident, f"Branch on {parameter}.", "Two simulated situations need a guarded transition.")

    for entry in brief["inputs"]:
        if entry["source"] in ("external", "clock") and entry.get("live") is False:
            ident = f"simulate:{entry['name']}"
            if ident in brief["rejected"]:
                continue
            entry["source"] = "simulated"
            entry["lands_as"] = "simulated_event"
            entry["confirmed"] = True
            if not entry.get("simulation"):
                entry["simulation"] = {"tic_unit": "", "tic_duration": 1, "situations": []}
            _assume(
                brief,
                ident,
                f"Simulate {entry['name']}.",
                "That source is being described, not connected.",
            )
        if entry["source"] == "person" and entry["lands_as"] != "console":
            ident = f"console:{entry['name']}"
            if ident in brief["rejected"]:
                continue
            entry["lands_as"] = "console"
            _assume(brief, ident, f"A console for {entry['name']}.", "A person enters this on a console.")

    feeds_console = any(entry["lands_as"] == "console" for entry in brief["inputs"])
    feeds_seed = any(entry["source"] == "seed" for entry in brief["inputs"])
    if feeds_console and not feeds_seed and "seed" not in brief["rejected"]:
        brief["inputs"].append(
            {
                "name": "starting rows",
                "source": "seed",
                "lands_as": "execute_package",
                "confirmed": True,
                "live": None,
                "simulation": None,
            }
        )
        _assume(brief, "seed", "Seed one subject and one related record.", "The console would otherwise open empty.")
    _drop_records_question(brief)
    _drop_routine_question(brief)
    _drop_ontology_question(brief)
    return brief


def _undo(brief: dict[str, Any], ident: str) -> None:
    if ident.startswith("branch:"):
        for output in brief["outputs"]:
            if f"branch:{_label(output['name']) or 'decision'}" == ident:
                output["branch"] = None
    elif ident.startswith("link:"):
        _from, _to = ident.split(":")[1:]
        brief["ontology"]["links"] = [
            link
            for link in brief["ontology"]["links"]
            if not (link["from"] == _from and link["to"] == _to)
        ]
    elif ident.startswith("type:"):
        label = ident.split(":", 1)[1]
        if not label:
            return
        brief["ontology"]["types"] = [
            entry for entry in brief["ontology"]["types"] if entry.get("label") != label
        ]
        brief["multi_hop"]["path"] = [
            step for step in brief["multi_hop"].get("path") or [] if step != label
        ]
        brief["ontology"]["links"] = [
            link
            for link in brief["ontology"]["links"]
            if link.get("from") != label and link.get("to") != label
        ]
        drop_ids = {
            item["id"]
            for item in brief.get("assumptions") or []
            if item["id"].startswith("link:") and label in item["id"].split(":")[1:]
        }
        if drop_ids:
            brief["assumptions"] = [
                item for item in brief["assumptions"] if item["id"] not in drop_ids
            ]
            for link_id in drop_ids:
                if link_id not in brief["rejected"]:
                    brief["rejected"].append(link_id)
    elif ident == "hop":
        brief["multi_hop"]["needed"] = False
    elif ident == "seed":
        brief["inputs"] = [entry for entry in brief["inputs"] if entry["source"] != "seed"]
    elif ident.startswith("simulate:"):
        name = ident.split(":", 1)[1]
        for entry in brief["inputs"]:
            if entry["name"] == name and entry["source"] == "simulated":
                entry["source"] = "external"
                entry["lands_as"] = "external_event"
                entry["confirmed"] = False
                entry["live"] = None


RECORD_KINDS_QUESTION = "Which kinds of records does this system use?"
LEGACY_RECORD_KINDS_QUESTION = "Name at least one type."
_DECISION_RECORD_KINDS_QUESTION = "Which kinds of records does this decision use?"


def readiness(brief: dict[str, Any]) -> list[str]:
    """Problems that keep the brief from being confirmed. Empty means ready."""
    problems: list[str] = []
    types = (brief.get("ontology") or {}).get("types") or []
    labels = {item["label"] for item in types}
    path = (brief.get("multi_hop") or {}).get("path") or []
    named = bool(types or path)
    if not named:
        problems.append(RECORD_KINDS_QUESTION)
    outputs = brief.get("outputs") or []
    operations = brief.get("operations") or []
    screens = brief.get("screens") or []
    if not outputs and not operations and not screens:
        problems.append("Name the sequence that makes the decision.")
    for entry in operations:
        if entry["type"] not in labels:
            problems.append(f"The operation {entry['operation']} {entry['type']} uses {entry['type']}, which is not a type.")
    for screen in screens:
        for view in screen.get("views") or []:
            subject = view.get("subject") or ""
            if subject and subject not in labels:
                problems.append(f"The screen {screen['name']} uses {subject}, which is not a type.")
    for entry in brief.get("inputs") or []:
        if entry["source"] in ("clock", "external") and not entry["confirmed"]:
            problems.append(f"Confirm that {entry['name']} is a live {entry['source']} source.")
        if entry["source"] == "simulated":
            simulation = entry.get("simulation") or {}
            if not simulation.get("tic_unit"):
                problems.append(f"Say how {entry['name']} is simulated: the tic unit.")
            if not simulation.get("situations"):
                problems.append(f"Name at least one situation for {entry['name']}.")
    hop = brief.get("multi_hop") or {}
    links = (brief.get("ontology") or {}).get("links") or []
    if hop.get("needed"):
        path = hop.get("path") or []
        if len(path) < 2:
            problems.append("Multi-hop needs a path of at least two types.")
        else:
            for label in path:
                if label not in labels:
                    problems.append(f"The path names {label}, which is not a type.")
            for origin, target in zip(path, path[1:]):
                if not _link_between(links, origin, target):
                    problems.append(f"The path {origin} -> {target} has no link.")
    reconstruction = brief.get("reconstruction") or {}
    decision_shaped = bool(outputs) or bool(hop.get("needed")) or bool((brief.get("vector") or {}).get("used"))
    if decision_shaped and (
        not reconstruction.get("avoids_runtime_guess") or not str(reconstruction.get("because") or "").strip()
    ):
        problems.append("Say which link the sequence loads so the decision is not a similarity search.")
    vector = brief.get("vector") or {}
    if vector.get("used") and not vector.get("only_to_name_the_subject"):
        problems.append("Vector search cannot be the decision. It may only name the subject.")
    if vector.get("used") and not hop.get("needed"):
        problems.append("A hop read has to follow the vector search.")
    for question in brief.get("open_questions") or []:
        text = str(question.get("question") or "").strip()
        if named and is_records_question(text):
            continue
        if str(brief.get("routine") or "").strip() and _asks_for_the_routine(text):
            continue
        if _asks_to_confirm_the_ontology(text):
            continue
        if text and text not in problems:
            problems.append(text)
    return problems


_SLOT_QUESTION_PREFIXES = (
    "Confirm that ",
    "Say how ",
    "Name at least one situation",
)


def is_slot_question(text: str) -> bool:
    """A source, simulation, or situation check. The surface model can record it."""
    question = str(text or "").strip()
    return any(question.startswith(prefix) for prefix in _SLOT_QUESTION_PREFIXES)


def records_named(brief: dict[str, Any]) -> bool:
    """True when the plan already lists a record kind or a path."""
    ontology = brief.get("ontology") or {}
    types = ontology.get("types") or []
    path = (brief.get("multi_hop") or {}).get("path") or []
    return bool(types or path)


def _drop_records_question(brief: dict[str, Any]) -> None:
    """A named record answers the type question. Drop that question."""
    if not records_named(brief):
        return
    brief["open_questions"] = [
        item
        for item in brief.get("open_questions") or []
        if not is_records_question(str(item.get("question") or ""))
    ]


def _asks_for_the_routine(text: str) -> bool:
    """A follow-up that wants the user to name or narrow the routine."""
    question = str(text or "").strip()
    if "routine" not in question.lower():
        return False
    lowered = question.lower()
    return "?" in question or lowered.startswith("what") or lowered.startswith("which")


def _drop_routine_question(brief: dict[str, Any]) -> None:
    """The routine is written from the work they described. Do not ask them to name it."""
    if not str(brief.get("routine") or "").strip():
        return
    brief["open_questions"] = [
        item
        for item in brief.get("open_questions") or []
        if not _asks_for_the_routine(str(item.get("question") or ""))
    ]


def _asks_to_confirm_the_ontology(text: str) -> bool:
    """A follow-up that asks the user to supply or approve the record kinds or links."""
    question = str(text or "").strip()
    if not question:
        return False
    lowered = question.lower()
    if "already in this space" in lowered or "what should it be called" in lowered:
        return False
    if "which is not a type" in lowered:
        return True
    shaped = "?" in question or lowered.startswith(("what", "which", "could", "can you", "please"))
    if not shaped:
        return False
    about_structure = any(
        phrase in lowered
        for phrase in ("type", "record kind", "link structure", "links between", "ontology")
    )
    asks_them = any(
        phrase in lowered
        for phrase in (
            "confirm",
            "would you",
            "could you",
            "you'd like",
            "you would like",
            "define",
            "should be registered",
            "which kinds",
            "which types",
            "what types",
            "name at least one type",
        )
    )
    return about_structure and asks_them


def _drop_ontology_question(brief: dict[str, Any]) -> None:
    """The plan designs the record kinds and links. Do not ask the user to approve them."""
    brief["open_questions"] = [
        item
        for item in brief.get("open_questions") or []
        if not _asks_to_confirm_the_ontology(str(item.get("question") or ""))
    ]


def planner_question(brief: dict[str, Any]) -> str:
    """The question the planner wrote. A readiness line is not one of these."""
    named = records_named(brief)
    for question in brief.get("open_questions") or []:
        text = str(question.get("question") or "").strip()
        if not text or (named and is_records_question(text)) or _asks_to_confirm_the_ontology(text):
            continue
        return text
    return ""


def consultation_question(brief: dict[str, Any]) -> str:
    """The one thing to ask in chat. The planner's question wins over a checklist line."""
    asked = planner_question(brief)
    if asked:
        return asked
    blocking = readiness(brief)
    return blocking[0] if blocking else ""


def is_records_question(text: str) -> bool:
    question = str(text or "").strip()
    return question in (
        RECORD_KINDS_QUESTION,
        LEGACY_RECORD_KINDS_QUESTION,
        _DECISION_RECORD_KINDS_QUESTION,
    )


def reply_is_question(text: str) -> bool:
    body = str(text or "").strip()
    if not body:
        return False
    if "?" in body:
        return True
    first = body.split(None, 1)[0].strip(".,!").lower()
    return first in ("what", "why", "how", "which", "who", "when")


_RECORD_STOP = {
    "a",
    "an",
    "the",
    "type",
    "types",
    "record",
    "records",
    "kind",
    "kinds",
    "and",
    "or",
    "of",
    "is",
    "are",
    "use",
    "uses",
    "using",
    "for",
    "this",
    "these",
}


def _reply_pieces(text: str) -> list[str]:
    parts = [text.lower()]
    for separator in (",", "&", " and "):
        nxt: list[str] = []
        for part in parts:
            nxt.extend(part.split(separator))
        parts = nxt
    return parts


def record_labels(text: str) -> list[str]:
    """Labels from a short naming reply. Empty when the reply is a question or prose."""
    if reply_is_question(text):
        return []
    body = str(text or "").strip()
    if not body or len(body) > 80:
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for piece in _reply_pieces(body):
        words = [word.strip(".") for word in piece.split() if word.strip(".")]
        words = [word for word in words if word not in _RECORD_STOP]
        if len(words) != 1:
            return []
        label = _label(words[0])
        if not label or label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return labels


def _join_labels(labels: list[str]) -> str:
    if len(labels) <= 1:
        return labels[0] if labels else ""
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + f", and {labels[-1]}"


def add_record_kinds(brief: dict[str, Any], labels: list[str]) -> dict[str, Any]:
    """Store named record kinds. Does not append them to the path."""
    document = normalize_brief(brief)
    types = document["ontology"]["types"]
    have = {entry["label"] for entry in types}
    rejected = set(document.get("rejected") or [])
    for label in labels:
        if not label or label in have or f"type:{label}" in rejected:
            continue
        types.append(_blank_type(label))
        have.add(label)
    return apply_assumptions(document)


def records_explanation(brief: dict[str, Any]) -> tuple[str, str]:
    """What a record kind is, and the next line to ask once that is clear."""
    document = normalize_brief(brief)
    names = [entry["label"] for entry in document["ontology"]["types"]]
    if not names:
        names = list(document["multi_hop"].get("path") or [])
    if names:
        lead = (
            "A type is a kind of record. "
            f"This plan already uses {_join_labels(names)}. "
            "Reject one from the assumptions if it does not belong."
        )
    else:
        lead = (
            "A type is a kind of record the system keeps, such as post or author. "
            "Name the ones it keeps."
        )
    nxt = consultation_question(document)
    if is_records_question(nxt):
        nxt = ""
    if nxt:
        return f"{lead} {nxt}", nxt
    if names:
        confirm = "Confirm it when it looks right."
        return f"{lead} {confirm}", confirm
    return lead, ""


def heal_brief(brief: dict[str, Any]) -> dict[str, Any]:
    """Register record kinds the path already names."""
    return apply_assumptions(normalize_brief(brief))


def drop_open_question(brief: dict[str, Any], question: str) -> dict[str, Any]:
    """Remove one planner question so a reply to it cannot be asked again."""
    target = str(question or "").strip()
    kept = [
        item
        for item in brief.get("open_questions") or []
        if str(item.get("question") or "").strip() != target
    ]
    return {**brief, "open_questions": kept}


def update_brief(current: dict[str, Any] | None, patch: Any, role: str) -> dict[str, Any]:
    """Merge a model update. A surface change to the shape of the plan escalates."""
    base = normalize_brief(current) if current else empty_brief()
    incoming = patch if isinstance(patch, dict) else {}
    if role == "surface":
        if current is None or _structural_changed(base, incoming):
            return {
                "ok": False,
                "escalate": True,
                "error": "That changes the shape of the plan. The planner has to revise it.",
                "brief": base,
                "blocking": readiness(base),
            }
        merged = dict(base)
        before_slots = {
            "inputs": copy.deepcopy(base.get("inputs") or []),
            "assumptions": copy.deepcopy(base.get("assumptions") or []),
            "rejected": list(base.get("rejected") or []),
        }
        merged["inputs"] = copy.deepcopy(base.get("inputs") or [])
        merged["assumptions"] = copy.deepcopy(base.get("assumptions") or [])
        merged["rejected"] = list(base.get("rejected") or [])
        if "inputs" in incoming:
            merged["inputs"] = normalize_brief({"inputs": incoming.get("inputs")})["inputs"]
        if "open_questions" in incoming:
            merged["open_questions"] = _questions(incoming.get("open_questions"))
        if "assumptions" in incoming:
            keep = {item["id"] for item in _assumptions(incoming.get("assumptions"))}
            for assumption in list(merged["assumptions"]):
                if assumption["id"] not in keep:
                    if assumption["id"] not in merged["rejected"]:
                        merged["rejected"].append(assumption["id"])
                    _undo(merged, assumption["id"])
            merged["assumptions"] = [item for item in merged["assumptions"] if item["id"] in keep]
        if isinstance(incoming.get("rejected"), list):
            for ident in incoming["rejected"]:
                text = str(ident).strip()
                if text and text not in merged["rejected"]:
                    merged["rejected"].append(text)
                    _undo(merged, text)
            merged["assumptions"] = [
                item for item in merged["assumptions"] if item["id"] not in merged["rejected"]
            ]
        if not _surface_slots_changed(before_slots, merged):
            return {
                "ok": False,
                "escalate": True,
                "error": "That revises the plan. The planner has to update the brief.",
                "brief": base,
                "blocking": readiness(base),
            }
    else:
        merged = normalize_brief({**base, **incoming}) if incoming else base
        if "rejected" not in incoming:
            merged["rejected"] = list(base.get("rejected") or [])
        merged["status"] = "consulting"
    merged = apply_assumptions(merged)
    blocking = readiness(merged)
    return {"ok": True, "escalate": False, "brief": merged, "blocking": blocking, "ready": not blocking}


def _step_name(prefix: str, text: str) -> str:
    slug = _label(text) or "step"
    if slug[0].isdigit():
        slug = f"n_{slug}"
    name = slug if slug.startswith(prefix) else f"{prefix}_{slug}"
    return name[:80]


def _item(
    kind: str,
    summary: str,
    payload: dict[str, Any],
    *,
    note: str = "",
    pins: list[dict[str, str]] | None = None,
    inputs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    raw: dict[str, Any] = {"kind": kind, "summary": summary, "payload": payload}
    if note:
        raw["note"] = note
    if pins:
        raw["pins"] = pins
    if inputs:
        raw["inputs"] = inputs
    return chat_apply.normalize_item(raw)


def _named_inputs(brief: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"name": entry["name"], "source": entry["source"], "lands_as": entry["lands_as"]}
        for entry in brief.get("inputs") or []
    ]


def _schema_payload(entry: dict[str, Any]) -> dict[str, Any]:
    properties = []
    for prop in entry["properties"]:
        is_label = prop["key"] == entry["label_property"]
        properties.append(
            {
                "key": prop["key"],
                "value_type": prop["value_type"],
                "is_label": is_label,
                "is_required": is_label,
            }
        )
    return {"attributive_label": entry["label"], "properties": properties}


def _type_by_label(brief: dict[str, Any], label: str) -> dict[str, Any] | None:
    for entry in brief["ontology"]["types"]:
        if entry["label"] == label:
            return entry
    return None


def _taken_names(items: list[dict[str, Any]]) -> set[str]:
    taken: set[str] = set()
    for item in items:
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        for key in ("name", "attributive_label", "entry_step", "from_step", "to_step"):
            value = str(payload.get(key) or "").strip()
            if value:
                taken.add(value)
    return taken


def _fresh_name(base: str, taken: set[str], hint: str = "") -> str:
    if base not in taken:
        taken.add(base)
        return base
    hinted = _label(f"{base}_{hint}") if hint else ""
    if hinted and hinted not in taken:
        taken.add(hinted)
        return hinted
    suffix = 2
    while f"{base}_{suffix}" in taken:
        suffix += 1
    name = f"{base}_{suffix}"
    taken.add(name)
    return name


def _operation_name(operation: str, label: str) -> str:
    """Instance create is add_<type>. create_<type> is the one-time schema step."""
    prefix = "add" if operation == "create" else operation
    return _step_name(prefix, label)


def _resolve_operation(ref: str, label: str, fallback: str) -> str:
    if ref in _INSTANCE_OPERATIONS:
        return _operation_name(ref, label)
    return ref or fallback


def _return_items(entry: dict[str, Any]) -> list[dict[str, str]]:
    return [{"expression": f"n.{prop['key']}", "alias": prop["key"]} for prop in entry.get("properties") or []]


def _view_fields(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Fields a form view renders. A form view never shows its modules."""
    long_text = {"body", "content", "description", "bio"}
    fields: list[dict[str, Any]] = []
    for prop in entry.get("properties") or []:
        key = str(prop["key"])
        value_type = str(prop.get("value_type") or "string")
        options = prop.get("options")
        if value_type in ("number", "integer"):
            field_type = "number"
        elif value_type in ("checkbox", "radio", "select") and options:
            field_type = value_type
        elif key in long_text:
            field_type = "textarea"
        else:
            field_type = "text"
        field: dict[str, Any] = {
            "id": f"f_{key}",
            "name": key,
            "label": key.replace("_", " "),
            "type": field_type,
            "required": key == entry.get("label_property"),
            "placeholder": "",
            "page": 0,
        }
        if field_type in ("checkbox", "radio", "select"):
            if isinstance(options, list):
                field["options"] = ", ".join(str(item) for item in options if str(item).strip())
            else:
                field["options"] = str(options or "")
        fields.append(field)
    return fields


def _instance_payload(operation: str, entry: dict[str, Any]) -> dict[str, Any]:
    properties = entry.get("properties") or []
    payload: dict[str, Any] = {
        "name": _operation_name(operation, entry["label"]),
        "kind": "operation",
        "node_label": "INSTANCE",
        "attributive_label": entry["label"],
    }
    if operation == "list":
        payload["operation"] = "read"
        payload["return_items"] = _return_items(entry)
    elif operation == "read":
        payload["operation"] = "read"
        payload["limit"] = 1
        payload["return_items"] = _return_items(entry)
        payload["where"] = [{"property_key": "id", "operator": "=", "value": "$id"}]
        payload["parameters"] = [{"name": "id", "is_required": True}]
    elif operation == "create":
        payload["operation"] = "create"
        payload["instance_properties"] = [{"key": prop["key"], "value": f"${prop['key']}"} for prop in properties]
        payload["parameters"] = [
            {"name": prop["key"], "is_required": prop["key"] == entry.get("label_property")} for prop in properties
        ]
    elif operation == "update":
        payload["operation"] = "update"
        payload["where"] = [{"property_key": "id", "operator": "=", "value": "$id"}]
        payload["set_expressions"] = [f"n.{prop['key']} = ${prop['key']}" for prop in properties]
        payload["parameters"] = [{"name": "id", "is_required": True}] + [
            {"name": prop["key"], "is_required": False} for prop in properties
        ]
    else:
        payload["operation"] = "delete"
        payload["where"] = [{"property_key": "id", "operator": "=", "value": "$id"}]
        payload["delete_targets"] = ["n"]
        payload["parameters"] = [{"name": "id", "is_required": True}]
    return payload


def _wanted_operations(document: dict[str, Any]) -> list[dict[str, str]]:
    """Operations the brief names, plus the ones a screen has to call."""
    wanted = [dict(item) for item in document.get("operations") or []]
    seen = {(item["type"], item["operation"]) for item in wanted}
    for screen in document.get("screens") or []:
        for view in screen.get("views") or []:
            subject = view.get("subject") or ""
            if not subject:
                continue
            module = view["module"]
            data = view.get("data") or ""
            action = view.get("action") or ""
            if module == "table" and not data:
                data = "list"
            elif module == "form":
                data = data or "read"
                action = action or "update"
            for ref in (data, action):
                if ref not in _INSTANCE_OPERATIONS:
                    continue
                key = (subject, ref)
                if key in seen:
                    continue
                seen.add(key)
                wanted.append({"type": subject, "operation": ref})
    return wanted


def _append_instance_operations(document: dict[str, Any], items: list[dict[str, Any]]) -> None:
    taken = _taken_names(items)
    for spec in _wanted_operations(document):
        entry = _type_by_label(document, spec["type"])
        if entry is None:
            continue
        name = _operation_name(spec["operation"], spec["type"])
        if name in taken:
            continue
        items.append(
            _item(
                "upsert_query",
                f"{spec['operation']} {spec['type']}".capitalize(),
                _instance_payload(spec["operation"], entry),
            )
        )
        taken.add(name)


def _plain_read(name: str, entry: dict[str, Any], *, chained: bool, hops: list[dict[str, str]] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": name,
        "kind": "operation",
        "operation": "read",
        "node_label": "INSTANCE",
        "attributive_label": entry["label"],
        "return_items": [
            {"expression": f"n.{entry.get('label_property') or 'name'}", "alias": "subject"}
        ],
    }
    if hops:
        payload["hops"] = hops
    if chained:
        payload["add_as_sequence"] = False
    return payload


def _append_further_decisions(
    document: dict[str, Any], items: list[dict[str, Any]], types: list[dict[str, Any]]
) -> None:
    """Each output after the first is its own decision sequence."""
    outputs = document.get("outputs") or []
    if len(outputs) < 2:
        return
    taken = _taken_names(items)
    for output in outputs[1:]:
        subject = output.get("starts_at") or ((output.get("reads") or [None])[0])
        entry = _type_by_label(document, subject) if subject else None
        if entry is None and types:
            entry = types[0]
        if entry is None:
            continue
        branch = output.get("branch")
        read_name = _step_name("read", entry["label"])
        if read_name not in taken:
            items.append(
                _item(
                    "upsert_query",
                    f"Load {entry['label']}",
                    _plain_read(read_name, entry, chained=bool(branch)),
                )
            )
            taken.add(read_name)
        if not branch:
            continue
        parameter = branch["parameter"]
        decide = _fresh_name(_step_name("decide", parameter), taken, output["name"])
        yes_base = _step_name("when", branch["when_true"])
        no_base = _step_name("when", branch["when_false"])
        if yes_base == no_base:
            no_base = f"{no_base}_other"
        yes = _fresh_name(yes_base, taken, output["name"])
        no = _fresh_name(no_base, taken, output["name"])
        items.append(
            _item(
                "upsert_query",
                f"Decide {parameter}",
                {
                    "name": decide,
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "STEP",
                    "attributive_label": decide,
                    "add_as_sequence": False,
                    "operation_step": {
                        "name": parameter,
                        "groups": [
                            {
                                "statements": [
                                    {"x": f"${parameter}", "operator": "=", "y": branch["when_true"]}
                                ]
                            }
                        ],
                    },
                },
                note=f"Branch toward {branch['when_true']} or {branch['when_false']}.",
            )
        )
        for label, title in ((yes, branch["when_true"]), (no, branch["when_false"])):
            items.append(
                _item(
                    "upsert_query",
                    title,
                    {
                        "name": label,
                        "kind": "operation",
                        "operation": "create",
                        "node_label": "STEP",
                        "attributive_label": label,
                        "add_as_sequence": False,
                        "wait_step": {"mode": "duration", "duration_seconds": 0},
                    },
                )
            )
        items.append(
            _item(
                "create_transition",
                f"{read_name} to {decide}",
                {"from_step": read_name, "to_step": decide, "condition_type": "null"},
            )
        )
        items.append(
            _item(
                "create_transition",
                branch["when_true"],
                {
                    "from_step": decide,
                    "to_step": yes,
                    "condition_type": "parameter",
                    "condition": parameter,
                    "condition_expected": True,
                },
            )
        )
        items.append(
            _item(
                "create_transition",
                branch["when_false"],
                {
                    "from_step": decide,
                    "to_step": no,
                    "condition_type": "parameter",
                    "condition": parameter,
                    "condition_expected": False,
                },
            )
        )
        sequence_name = _label(output["name"]) or _step_name("run", entry["label"])
        if not sequence_name or sequence_name[0].isdigit():
            sequence_name = f"run_{sequence_name or entry['label']}"
        sequence_name = _fresh_name(sequence_name, taken)
        items.append(
            _item(
                "upsert_query",
                output["name"],
                {
                    "name": sequence_name,
                    "kind": "sequence",
                    "entry_step": read_name,
                    "traversal": "downstream",
                },
            )
        )


def _link_from(links: list[dict[str, str]], subject: str) -> dict[str, str] | None:
    for link in links:
        if link["from"] == subject:
            return link
    return None


def _append_screens(
    document: dict[str, Any], items: list[dict[str, Any]], sequence_name: str, links: list[dict[str, str]]
) -> None:
    screens = document.get("screens") or []
    if not screens:
        return
    taken = _taken_names(items)
    for screen in screens:
        views: list[dict[str, Any]] = []
        for index, view in enumerate(screen["views"]):
            entry = _type_by_label(document, view.get("subject") or "")
            if entry is None and document["ontology"]["types"]:
                entry = document["ontology"]["types"][0]
            if entry is None:
                continue
            subject = entry["label"]
            module = view["module"]
            data_ref = view.get("data") or ""
            action_ref = view.get("action") or ""
            if module == "table" and not data_ref:
                data_ref = "list"
            elif module == "form":
                data_ref = data_ref or "read"
                action_ref = action_ref or "update"
            data_name = _resolve_operation(data_ref, subject, sequence_name) if data_ref else sequence_name
            action_name = _resolve_operation(action_ref, subject, sequence_name) if action_ref else ""
            if module == "graph":
                link = _link_from(links, subject)
                if link is not None:
                    hop_name = _step_name("read", f"{subject}_{link['to']}")
                    if hop_name not in taken:
                        items.append(
                            _item(
                                "upsert_query",
                                f"Load {subject} and {link['to']}",
                                _plain_read(
                                    hop_name,
                                    entry,
                                    chained=False,
                                    hops=[
                                        {
                                            "relationship_label": link["label"],
                                            "target_label": link["to"],
                                            "target_source": "existing",
                                        }
                                    ],
                                ),
                            )
                        )
                        taken.add(hop_name)
                    data_name = hop_name
            if module == "form" and (not action_name or action_name == data_name):
                alternate = _operation_name("create", subject)
                if alternate == data_name:
                    alternate = _operation_name("update", subject)
                action_name = alternate
            if module == "form":
                views.append(
                    {
                        "id": _label(view["name"]) or f"view_{index}",
                        "name": view["name"] or subject,
                        "kind": "form",
                        "dataSequenceId": data_name,
                        "actionSequenceId": action_name or data_name,
                        "submitLabel": "submit",
                        "fields": _view_fields(entry),
                    }
                )
                continue
            if module == "number":
                config: dict[str, Any] = {"dataPath": "", "label": view["name"] or subject}
            elif module == "button":
                config = {
                    "dataPath": "",
                    "label": view["name"] or "Run",
                    "color": "accent",
                    "payload": view["name"] or "run",
                }
            else:
                config = {"dataPath": ""}
            module_body: dict[str, Any] = {
                "id": f"m_{index}",
                "type": module,
                "title": view["name"] or subject,
                "dataSource": "sequence",
                "dataSequenceId": data_name,
                "config": config,
            }
            if module in _ACTION_MODULES:
                module_body["actionSource"] = "sequence"
                module_body["actionSequenceId"] = action_name or data_name
            views.append(
                {
                    "id": _label(view["name"]) or f"view_{index}",
                    "name": view["name"] or subject,
                    "kind": "live",
                    "modules": [module_body],
                }
            )
        if not views:
            continue
        items.append(
            _item(
                "upsert_console",
                screen["name"],
                {"name": screen["name"], "document": {"views": views, "activeViewId": views[0]["id"]}},
            )
        )


def compile_brief(brief: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn a brief into ordered change items. Does not check readiness."""
    document = normalize_brief(brief)
    document = apply_assumptions(document)
    types = document["ontology"]["types"]
    links = document["ontology"]["links"]
    output = document["outputs"][0] if document["outputs"] else None
    subject = types[0]["label"] if types else "record"
    because = str(document["reconstruction"].get("because") or "")
    items: list[dict[str, Any]] = []
    inputs = _named_inputs(document)

    for entry in types:
        pins = [{"target": entry["label"], "note": because}] if because and not items else None
        items.append(
            _item(
                "upsert_schema",
                f"Type {entry['label']}",
                _schema_payload(entry),
                note=because if not items else "",
                pins=pins,
            )
        )

    for link in links:
        items.append(
            _item(
                "upsert_query",
                f"Link {link['from']} to {link['to']}",
                {
                    "name": f"link_{link['label']}",
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "SCHEMA",
                    "attributive_label": link["from"],
                    "anchor_source": "existing",
                    "add_as_sequence": False,
                    "hops": [
                        {
                            "relationship_label": link["label"],
                            "target_label": link["to"],
                            "target_source": "existing",
                        }
                    ],
                },
                note=link["infers"],
                pins=[{"target": link["label"], "note": link["infers"]}],
            )
        )

    setup_count = len(items)
    steps: list[str] = []
    hop_path = document["multi_hop"]["path"] if document["multi_hop"]["needed"] else []
    if document["multi_hop"]["needed"] and len(hop_path) < 2 and links:
        hop_path = [links[0]["from"], links[0]["to"]]
    hops = []
    for origin, target in zip(hop_path, hop_path[1:]):
        link = _link_between(links, origin, target)
        if link is None:
            continue
        hops.append(
            {
                "relationship_label": link["label"],
                "target_label": target,
                "target_source": "existing",
            }
        )
    vector = document["vector"]
    chain = bool(output and output["kind"] == "chain") or bool(hops) or bool(vector.get("used")) or bool(
        output and output.get("branch")
    )
    # The find and the read are operations. Each is wrapped as a STEP of this same
    # name, and the links and sequence point at that name.
    read_name = _step_name("read", subject)
    if vector.get("used"):
        find_name = _step_name("find", subject)
        items.append(
            _item(
                "upsert_query",
                f"Find the {subject}",
                {
                    "name": find_name,
                    "kind": "operation",
                    "operation": "read",
                    "node_label": "INSTANCE",
                    "attributive_label": subject,
                    "add_as_sequence": False,
                    "vector_search": {
                        "enabled": True,
                        "text": vector.get("text") or document["routine"] or subject,
                        "k": 5,
                    },
                },
                note="Names the subject. The next step walks what that record points to.",
            )
        )
        steps.append(find_name)
    read_payload: dict[str, Any] = {
        "name": read_name,
        "kind": "operation",
        "operation": "read",
        "node_label": "INSTANCE",
        "attributive_label": subject,
        "return_items": [
            {
                "expression": f"n.{(types[0]['label_property'] if types else 'name')}",
                "alias": "subject",
            }
        ],
    }
    if hops:
        read_payload["hops"] = hops
    if chain:
        read_payload["add_as_sequence"] = False
    items.append(
        _item(
            "upsert_query",
            f"Load {subject}",
            read_payload,
            note=because,
        )
    )
    steps.append(read_name)

    if output and output.get("branch"):
        branch = output["branch"]
        decide = _step_name("decide", branch["parameter"])
        yes = _step_name("when", branch["when_true"])
        no = _step_name("when", branch["when_false"])
        if yes == no:
            no = f"{no}_other"
        items.append(
            _item(
                "upsert_query",
                f"Decide {branch['parameter']}",
                {
                    "name": decide,
                    "kind": "operation",
                    "operation": "create",
                    "node_label": "STEP",
                    "attributive_label": decide,
                    "add_as_sequence": False,
                    "operation_step": {
                        "name": branch["parameter"],
                        "groups": [
                            {
                                "statements": [
                                    {
                                        "x": f"${branch['parameter']}",
                                        "operator": "=",
                                        "y": branch["when_true"],
                                    }
                                ]
                            }
                        ],
                    },
                },
                note=f"Branch toward {branch['when_true']} or {branch['when_false']}.",
                pins=[
                    {
                        "target": branch["parameter"],
                        "note": f"Branch toward {branch['when_true']} or {branch['when_false']}.",
                    }
                ],
            )
        )
        for label, title in ((yes, branch["when_true"]), (no, branch["when_false"])):
            items.append(
                _item(
                    "upsert_query",
                    title,
                    {
                        "name": label,
                        "kind": "operation",
                        "operation": "create",
                        "node_label": "STEP",
                        "attributive_label": label,
                        "add_as_sequence": False,
                        "wait_step": {"mode": "duration", "duration_seconds": 0},
                    },
                )
            )
        items.append(
            _item(
                "create_transition",
                f"{read_name} to {decide}",
                {"from_step": read_name, "to_step": decide, "condition_type": "null"},
            )
        )
        items.append(
            _item(
                "create_transition",
                branch["when_true"],
                {
                    "from_step": decide,
                    "to_step": yes,
                    "condition_type": "parameter",
                    "condition": branch["parameter"],
                    "condition_expected": True,
                },
            )
        )
        items.append(
            _item(
                "create_transition",
                branch["when_false"],
                {
                    "from_step": decide,
                    "to_step": no,
                    "condition_type": "parameter",
                    "condition": branch["parameter"],
                    "condition_expected": False,
                },
            )
        )
        steps.extend([decide, yes, no])

    if vector.get("used") and len(steps) >= 2:
        items.append(
            _item(
                "create_transition",
                f"{steps[0]} to {steps[1]}",
                {"from_step": steps[0], "to_step": steps[1], "condition_type": "null"},
            )
        )

    sequence_name = _label(output["name"]) if output else _step_name("run", subject)
    if not sequence_name or sequence_name[0].isdigit():
        sequence_name = f"run_{sequence_name or subject}"
    if len(steps) > 1:
        items.append(
            _item(
                "upsert_query",
                output["name"] if output else sequence_name,
                {
                    "name": sequence_name,
                    "kind": "sequence",
                    "entry_step": steps[0],
                    "traversal": "downstream",
                },
                note=because,
            )
        )
    else:
        sequence_name = read_name

    # A system of record operations and screens is not a decision read.
    # The spine above is the one-decision path; drop it when the brief chose the other shape.
    content_only = (
        not document["outputs"]
        and not document["multi_hop"]["needed"]
        and not vector.get("used")
        and (document["operations"] or document["screens"])
    )
    if content_only:
        del items[setup_count:]
        sequence_name = _step_name("run", subject)
    _append_instance_operations(document, items)
    _append_further_decisions(document, items, types)
    _append_screens(document, items, sequence_name, links)

    for entry in document["inputs"]:
        if entry["source"] == "seed":
            related = links[0] if links else None
            payload = {
                "name": _step_name("seed", subject),
                "kind": "operation",
                "operation": "create",
                "node_label": "INSTANCE",
                "attributive_label": subject,
                "instance_properties": [
                    {
                        "key": types[0]["label_property"] if types else "name",
                        "value": "Example",
                    }
                ],
                "execute": True,
                "add_as_sequence": False,
            }
            if related is not None:
                other = _type_by_label(document, related["to"])
                payload["hops"] = [
                    {
                        "relationship_label": related["label"],
                        "target_label": related["to"],
                        "target_source": "new",
                        "instance_properties": [
                            {
                                "key": other["label_property"] if other else "name",
                                "value": "Related",
                            }
                        ],
                    }
                ]
            items.append(_item("upsert_query", "Starting rows", payload, note="Seeded so the view is not empty."))
        elif entry["source"] == "person" or entry["lands_as"] == "console":
            if document["screens"]:
                continue
            items.append(
                _item(
                    "upsert_console",
                    entry["name"],
                    {
                        "name": entry["name"],
                        "document": {
                            "views": [
                                {
                                    "id": "live",
                                    "name": "Live",
                                    "kind": "live",
                                    "modules": [
                                        {
                                            "id": "ask",
                                            "type": "number",
                                            "title": entry["name"],
                                            "dataSource": "sequence",
                                            "dataSequenceId": sequence_name,
                                            "actionSource": "sequence",
                                            "actionSequenceId": sequence_name,
                                            "config": {"label": entry["name"]},
                                        }
                                    ],
                                }
                            ],
                            "activeViewId": "live",
                        },
                    },
                )
            )
        elif entry["source"] == "clock":
            items.append(
                _item(
                    "upsert_event",
                    entry["name"],
                    {
                        "name": entry["name"],
                        "type": "time",
                        "sequences": [sequence_name],
                        "event_package": {
                            "timezone": "UTC",
                            "groups": [{"is_time": "09:00", "is_weekday": [1, 2, 3, 4, 5]}],
                        },
                    },
                )
            )
        elif entry["source"] == "external":
            items.append(
                _item(
                    "upsert_event",
                    entry["name"],
                    {
                        "name": entry["name"],
                        "type": "external",
                        "sequences": [sequence_name],
                        "external_package": {
                            "filters": [{"path": "event", "operator": "equals", "value": entry["name"]}],
                        },
                    },
                )
            )
        elif entry["source"] == "simulated" and entry["lands_as"] == "simulated_event":
            simulation = entry.get("simulation") or {}
            probabilities = []
            for situation in simulation.get("situations") or [{"name": entry["name"], "parameters": {}}]:
                probabilities.append(
                    {
                        "name": situation["name"],
                        "schedule": {"type": "recurring", "every_x": 1, "delay_y": 0},
                        "outcomes": [
                            {
                                "label": situation["name"],
                                "weight": 1,
                                "payload": situation.get("parameters") or {},
                                "payload_mode": "fields",
                            }
                        ],
                    }
                )
            items.append(
                _item(
                    "upsert_event",
                    entry["name"],
                    {
                        "name": entry["name"],
                        "type": "simulated",
                        "sequences": [sequence_name],
                        "simulation_package": {
                            "tic_unit": simulation.get("tic_unit") or "hours",
                            "tic_duration": simulation.get("tic_duration") or 1,
                            "probabilities": probabilities,
                        },
                    },
                    note="Simulated because this source is not connected yet.",
                )
            )

    if items and inputs:
        items[0]["inputs"] = inputs
    return items


def _item_identity(item: dict[str, Any]) -> dict[str, str]:
    """The graph name an item would claim, and the role that decides a collision."""
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    kind = str(item.get("kind") or "")
    if kind == "upsert_schema":
        label = str(payload.get("attributive_label") or "").strip()
        return {"role": "schema", "primary": label, "step": f"create_{label}" if label else ""}
    if kind == "create_transition":
        return {
            "role": "transition",
            "primary": "",
            "from": str(payload.get("from_step") or "").strip(),
            "to": str(payload.get("to_step") or "").strip(),
        }
    if kind == "upsert_console":
        return {"role": "console", "primary": str(payload.get("name") or "").strip()}
    if kind == "upsert_query":
        name = str(payload.get("name") or "").strip()
        if str(payload.get("kind") or "") == "sequence":
            return {"role": "sequence", "primary": name, "entry": str(payload.get("entry_step") or "").strip()}
        if str(payload.get("node_label") or "") == "STEP":
            return {"role": "step", "primary": str(payload.get("attributive_label") or name).strip()}
        return {"role": "step", "primary": name}
    return {"role": "other", "primary": ""}


def _name_conflict(summary: str, taken: str) -> str:
    return f"{summary} cannot be created: {taken} is already in this space. What should it be called instead?"


_SET_PROPERTY = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)\s*=")
_RETURN_PROPERTY = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)$")


def _named_values(raw: Any, *keys: str) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    names: list[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
            continue
        if not isinstance(item, dict):
            continue
        name = ""
        for key in keys:
            name = str(item.get(key) or "").strip()
            if name:
                break
        if name:
            names.append(name)
    return tuple(sorted(names))


def _return_keys(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    names: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        alias = str(item.get("alias") or "").strip()
        if alias:
            names.append(alias)
            continue
        match = _RETURN_PROPERTY.search(str(item.get("expression") or "").strip())
        if match:
            names.append(match.group(1))
    return tuple(sorted(names))


def _set_keys(raw: Any) -> tuple[str, ...]:
    expressions: list[str] = []
    if isinstance(raw, str):
        expressions.append(raw)
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                expressions.append(item)
            elif isinstance(item, dict):
                expressions.append(str(item.get("expression") or ""))
    names = []
    for expression in expressions:
        match = _SET_PROPERTY.search(expression)
        if match:
            names.append(match.group(1))
    return tuple(sorted(names))


def _first_query_node(query: dict[str, Any]) -> dict[str, Any] | None:
    match = query.get("match")
    if not isinstance(match, list) or not match or not isinstance(match[0], dict):
        return None
    patterns = match[0].get("patterns")
    if not isinstance(patterns, list) or not patterns or not isinstance(patterns[0], dict):
        return None
    path = patterns[0].get("path")
    if not isinstance(path, list) or not path or not isinstance(path[0], dict):
        return None
    node = path[0].get("node")
    return node if isinstance(node, dict) else None


def _operation_signature(payload: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(payload.get("operation") or ""),
        str(payload.get("attributive_label") or ""),
        _named_values(payload.get("parameters"), "name"),
        _return_keys(payload.get("return_items")),
        _named_values(payload.get("instance_properties"), "key", "name"),
        _set_keys(payload.get("set_expressions")),
    )


def _stored_operation_signature(package: dict[str, Any]) -> tuple[Any, ...] | None:
    config = package.get("builder_config") if isinstance(package.get("builder_config"), dict) else {}
    query = config.get("query") if isinstance(config, dict) and isinstance(config.get("query"), dict) else None
    if not isinstance(query, dict):
        return None
    node = _first_query_node(query) or {}
    returns = query.get("return") if isinstance(query.get("return"), dict) else {}
    return (
        str(query.get("operation") or package.get("operation") or ""),
        str(node.get("attributive_label") or ""),
        _named_values(query.get("parameters") or package.get("parameters"), "name"),
        _return_keys(returns.get("items")),
        _named_values(node.get("properties"), "key", "name"),
        _set_keys(query.get("set")),
    )


def _operation_differs(payload: dict[str, Any], package: dict[str, Any]) -> bool:
    stored = _stored_operation_signature(package)
    if stored is None:
        return True
    return _operation_signature(payload) != stored


def _schema_property(prop: dict[str, Any], *, key: str) -> dict[str, Any]:
    """Chat schema properties are named with ``name``, the same shape a create already uses."""
    value_type = str(prop.get("value_type") or "string")
    out: dict[str, Any] = {
        "name": key,
        "value_type": value_type,
        "is_required": bool(prop.get("is_required")),
        "is_key": bool(prop.get("is_key")),
        "is_label": bool(prop.get("is_label")),
        "is_indexed": bool(prop.get("is_indexed")),
    }
    if prop.get("is_embedded"):
        out["is_embedded"] = True
    if value_type == "string" and prop.get("format"):
        out["format"] = prop.get("format")
    if value_type in ("radio", "checkbox") and prop.get("options"):
        out["options"] = prop.get("options")
    default_value = prop.get("default_value")
    if default_value is not None and str(default_value).strip() != "":
        out["default_value"] = default_value
    return out


def _merge_schema_properties(
    stored: list[Any], compiled: list[Any]
) -> tuple[list[dict[str, Any]], bool]:
    """Keep every saved property and append keys the plan adds.

    A retained property's flags stay as they are. A new key is optional, and it is not
    the label when the schema already has one, so existing rows stay valid.
    """
    kept: list[dict[str, Any]] = []
    seen: set[str] = set()
    has_label = False
    for prop in stored:
        if not isinstance(prop, dict):
            continue
        key = str(prop.get("key") or prop.get("name") or "").strip()
        if not key or key in seen:
            continue
        kept.append(_schema_property(prop, key=key))
        seen.add(key)
        if prop.get("is_label"):
            has_label = True
    added = False
    for prop in compiled:
        if not isinstance(prop, dict):
            continue
        key = str(prop.get("key") or prop.get("name") or "").strip()
        if not key or key in seen:
            continue
        extra = _schema_property(prop, key=key)
        extra["is_key"] = False
        if has_label:
            extra["is_label"] = False
            extra["is_required"] = False
        elif extra["is_label"]:
            has_label = True
        kept.append(extra)
        seen.add(key)
        added = True
    return kept, added


def _field_names_from(raw: Any) -> list[str]:
    fields = raw
    if isinstance(fields, str):
        try:
            fields = json.loads(fields)
        except json.JSONDecodeError:
            return []
    if not isinstance(fields, list):
        return []
    names: list[str] = []
    for field in fields:
        if isinstance(field, dict) and str(field.get("name") or "").strip():
            names.append(str(field["name"]).strip())
    return names


def _console_fingerprint(document: dict[str, Any]) -> tuple[Any, ...]:
    views: list[tuple[Any, ...]] = []
    for view in document.get("views") or []:
        if not isinstance(view, dict):
            continue
        names = _field_names_from(view.get("fields"))
        modules: list[tuple[str, str, str]] = []
        for module in view.get("modules") or []:
            if not isinstance(module, dict):
                continue
            config = module.get("config") if isinstance(module.get("config"), dict) else {}
            names.extend(_field_names_from(config.get("fields")))
            modules.append(
                (
                    str(module.get("type") or ""),
                    str(module.get("dataSequenceId") or ""),
                    str(module.get("actionSequenceId") or ""),
                )
            )
        views.append(
            (
                str(view.get("name") or ""),
                str(view.get("kind") or ""),
                str(view.get("dataSequenceId") or ""),
                str(view.get("actionSequenceId") or ""),
                tuple(sorted(names)),
                tuple(sorted(modules)),
            )
        )
    return tuple(views)


def _bind_existing(item: dict[str, Any], **payload: Any) -> dict[str, Any]:
    bound = copy.deepcopy(item)
    body = bound.get("payload") if isinstance(bound.get("payload"), dict) else {}
    body.update(payload)
    bound["payload"] = body
    return bound


def reconcile_compiled(
    items: list[dict[str, Any]],
    *,
    schemas: set[str],
    steps: set[str],
    sequences: set[str] | None = None,
    consoles: set[str] | None = None,
    records: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Keep a new name, update an existing one whose body differs, and refuse a suffixed name.

    A name that already exists is left out when the saved schema, operation, or console
    matches the plan. When properties, parameters, or form fields differ, the item stays
    and carries the existing id. Without a saved body, an occupied name is left as it is.
    A new name that collides with a different existing label is a conflict.
    """
    sequence_names = sequences or set()
    console_names = {name.lower() for name in (consoles or set())}
    saved = records or {}
    schema_records = saved.get("schemas") if isinstance(saved.get("schemas"), dict) else {}
    operation_records = saved.get("operations") if isinstance(saved.get("operations"), dict) else {}
    console_records = saved.get("consoles") if isinstance(saved.get("consoles"), dict) else {}
    decisions: list[tuple[str, Any]] = []
    for item in items:
        identity = _item_identity(item)
        summary = str(item.get("summary") or identity.get("primary") or "item").strip() or "item"
        role = identity["role"]
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if role == "schema":
            label = identity.get("primary") or ""
            step_name = identity.get("step") or ""
            if label and label in schemas:
                record = schema_records.get(label) if isinstance(schema_records.get(label), dict) else None
                schema_id = str((record or {}).get("id") or "").strip()
                if record and schema_id:
                    merged, added = _merge_schema_properties(
                        record.get("properties") or [], payload.get("properties") or []
                    )
                    if added:
                        decisions.append(
                            (
                                "keep",
                                _bind_existing(
                                    item,
                                    properties=merged,
                                    schema_id=schema_id,
                                    update_existing=True,
                                ),
                            )
                        )
                        continue
                decisions.append(("already", summary))
                continue
            taken = ""
            if label and label in steps:
                taken = label
            elif step_name and (step_name in steps or step_name in schemas):
                taken = step_name
            if taken:
                decisions.append(("conflict", _name_conflict(summary, taken)))
                continue
            decisions.append(("keep", item))
            continue
        if role == "step":
            name = identity.get("primary") or ""
            if name and name in steps:
                record = operation_records.get(name) if isinstance(operation_records.get(name), dict) else None
                operation_id = str((record or {}).get("id") or "").strip()
                if record and operation_id and _operation_differs(payload, record):
                    decisions.append(("keep", _bind_existing(item, id=operation_id)))
                    continue
                decisions.append(("already", summary))
                continue
            if name and name in schemas:
                decisions.append(("conflict", _name_conflict(summary, name)))
                continue
            decisions.append(("keep", item))
            continue
        if role in ("sequence", "transition"):
            decisions.append(("later", item))
            continue
        if role == "console":
            name = identity.get("primary") or ""
            if name and name.lower() in console_names:
                record = console_records.get(name.lower()) if isinstance(console_records.get(name.lower()), dict) else None
                console_id = str((record or {}).get("id") or "").strip()
                saved_document = (record or {}).get("document") if isinstance((record or {}).get("document"), dict) else {}
                compiled_document = payload.get("document") if isinstance(payload.get("document"), dict) else {}
                if record and console_id and _console_fingerprint(saved_document) != _console_fingerprint(compiled_document):
                    decisions.append(("keep", _bind_existing(item, id=console_id)))
                    continue
                decisions.append(("already", summary))
                continue
            decisions.append(("keep", item))
            continue
        decisions.append(("keep", item))

    created: set[str] = set()
    for kind, payload in decisions:
        if kind != "keep":
            continue
        identity = _item_identity(payload)
        if identity["role"] == "schema" and identity.get("step") and identity["step"] not in steps:
            created.add(identity["step"])
        elif identity["role"] == "step" and identity.get("primary") and identity["primary"] not in steps:
            created.add(identity["primary"])

    kept: list[dict[str, Any]] = []
    already: list[str] = []
    conflicts: list[str] = []
    for kind, payload in decisions:
        if kind == "already":
            already.append(str(payload))
            continue
        if kind == "conflict":
            conflicts.append(str(payload))
            continue
        if kind == "keep":
            kept.append(payload)
            continue
        item = payload
        identity = _item_identity(item)
        summary = str(item.get("summary") or identity.get("primary") or "link").strip() or "link"
        if identity["role"] == "transition":
            ends = [identity.get("from") or "", identity.get("to") or ""]
            if all(end and end in steps and end not in created for end in ends):
                already.append(summary)
                continue
            kept.append(item)
            continue
        name = identity.get("primary") or ""
        if name and (name in sequence_names or name in steps):
            already.append(summary)
            continue
        if name and name in schemas:
            conflicts.append(_name_conflict(summary, name))
            continue
        kept.append(item)

    # A seed exists so a new console is not empty. Once the designed pieces are already
    # in the space, seeding again is not a plan of its own.
    if already and not conflicts and kept and all(_is_assumed_seed(item) for item in kept):
        kept = []

    return {
        "items": kept,
        "already": already,
        "conflicts": conflicts,
        "configured": bool(already) and not kept and not conflicts,
    }


def _is_assumed_seed(item: dict[str, Any]) -> bool:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    name = str(payload.get("name") or "")
    return (
        item.get("kind") == "upsert_query"
        and payload.get("execute") is True
        and name.startswith("seed_")
    )


def apply_name_check(brief: dict[str, Any], reconciled: dict[str, Any]) -> dict[str, Any]:
    """Ask about a covered space, or about a name that cannot be created, before the plan is ready."""
    kept: list[Any] = []
    for question in brief.get("open_questions") or []:
        if isinstance(question, dict) and question.get("blocks") in _NAME_BLOCKS:
            continue
        kept.append(question)
    synthetic: list[dict[str, str]] = []
    if reconciled.get("configured"):
        synthetic.append({"id": "configured", "question": ALREADY_CONFIGURED, "blocks": "configured"})
    else:
        for index, text in enumerate(reconciled.get("conflicts") or []):
            synthetic.append({"id": f"name-{index}", "question": str(text), "blocks": "names"})
    questions = synthetic + kept
    current = list(brief.get("open_questions") or [])
    if questions == current:
        return brief
    return {**brief, "open_questions": questions}


def _graph_labels(space_id: str, node_label: str) -> set[str]:
    from . import graph

    if node_label not in ("SCHEMA", "STEP"):
        return set()
    out = graph.run_cypher_for_space(
        space_id,
        (
            f"MATCH (n:{node_label}) "
            "WHERE n.attributive_label IS NOT NULL "
            "RETURN n.attributive_label AS attributive_label"
        ),
        {},
    )
    labels: set[str] = set()
    for row in out.get("records") or []:
        label = str(row.get("attributive_label") or "").strip()
        if label:
            labels.add(label)
    return labels


def load_space_names(space_id: str) -> dict[str, set[str]] | None:
    """Schema labels, step labels, sequence titles, and console names. None when the read fails."""
    try:
        from . import catalog

        schemas = _graph_labels(space_id, "SCHEMA")
        steps = _graph_labels(space_id, "STEP")
        sequences: set[str] = set()
        for row in catalog.fetch_saved_queries():
            if str(row.get("kind") or "") != "sequence":
                continue
            name = str(row.get("name") or "").strip()
            if name:
                sequences.add(name)
        consoles: set[str] = set()
        for row in catalog.list_consoles(space_id):
            name = str(row.get("name") or "").strip().lower()
            if name:
                consoles.add(name)
    except Exception:
        return None
    return {"schemas": schemas, "steps": steps, "sequences": sequences, "consoles": consoles}


def _join_names(names: set[str], limit: int) -> str:
    ordered = sorted(names)
    shown = ordered[:limit]
    text = ", ".join(shown) if shown else "(none)"
    extra = len(ordered) - len(shown)
    if extra:
        text += f" (+{extra} more)"
    return text


def space_names_note(space_id: str) -> str:
    """Planner context: the names already stored for this space."""
    loaded = load_space_names(space_id)
    if loaded is None:
        return ""
    if not loaded["schemas"] and not loaded["steps"]:
        return "This space has no schemas or steps yet. Names you choose are new."
    return (
        "Schemas and steps already in this space. A name in these lists exists. "
        "Keep a record kind in the brief when the system uses it. Do not plan a second copy of it. "
        "If the user wants a property, a form field, or an operation the saved record does not have, "
        "call update_plan with that change. Say the space is already configured only when it already "
        "does what they asked for.\n"
        f"Schemas: {_join_names(loaded['schemas'], 80)}\n"
        f"Steps: {_join_names(loaded['steps'], 120)}"
    )


def load_space_records(space_id: str, items: list[dict[str, Any]]) -> dict[str, dict]:
    """Saved schema, operation, and console bodies for names this plan would claim."""
    empty: dict[str, dict] = {"schemas": {}, "operations": {}, "consoles": {}}
    wanted_schemas: set[str] = set()
    wanted_steps: set[str] = set()
    wanted_consoles: set[str] = set()
    for item in items:
        identity = _item_identity(item)
        primary = identity.get("primary") or ""
        if identity["role"] == "schema" and primary:
            wanted_schemas.add(primary)
        elif identity["role"] == "step" and primary:
            wanted_steps.add(primary)
        elif identity["role"] == "console" and primary:
            wanted_consoles.add(primary.lower())
    if not wanted_schemas and not wanted_steps and not wanted_consoles:
        return empty
    records: dict[str, dict] = {"schemas": {}, "operations": {}, "consoles": {}}
    try:
        from . import catalog, graph

        for label in wanted_schemas:
            try:
                definition = graph.fetch_schema_definition(space_id, label)
            except Exception:
                continue
            schema_id = str(definition.get("schema_id") or "").strip()
            properties = definition.get("schemata") if isinstance(definition.get("schemata"), list) else []
            if schema_id:
                records["schemas"][label] = {"id": schema_id, "properties": properties}
        if wanted_steps:
            query_ids: dict[str, str] = {}
            try:
                for node in graph.list_graph_nodes_by_label(space_id, "STEP"):
                    label = str(node.get("attributive_label") or "")
                    query_id = str(
                        ((node.get("sequencial_properties") or {}).get("query_id") or "")
                    ).strip()
                    if label in wanted_steps and query_id:
                        query_ids[label] = query_id
            except Exception:
                query_ids = {}
            try:
                rows = catalog.fetch_saved_queries()
            except Exception:
                rows = []
            for row in rows:
                if str(row.get("kind") or "") == "sequence":
                    continue
                name = str(row.get("name") or "").strip()
                query_id = str(row.get("id") or "").strip()
                if name in wanted_steps and name not in query_ids and query_id:
                    query_ids[name] = query_id
            for name, query_id in query_ids.items():
                package = None
                try:
                    package = catalog.fetch_query_package(query_id)
                except Exception:
                    package = None
                if isinstance(package, dict):
                    saved_package = dict(package)
                    saved_package["id"] = saved_package.get("id") or query_id
                    records["operations"][name] = saved_package
                else:
                    records["operations"][name] = {"id": query_id, "parameters": []}
        if wanted_consoles:
            try:
                rows = catalog.list_consoles(space_id)
            except Exception:
                rows = []
            for row in rows:
                name = str(row.get("name") or "").strip().lower()
                if name not in wanted_consoles or name in records["consoles"]:
                    continue
                document = row.get("document") if isinstance(row.get("document"), dict) else {}
                records["consoles"][name] = {"id": str(row.get("id") or ""), "document": document}
    except Exception:
        return empty
    return records


def preview_for_brief(space_id: str, brief: dict[str, Any]) -> dict[str, Any]:
    """Compile a brief, then leave, update, or question each name the live space already holds."""
    items = compile_brief(brief)
    loaded = load_space_names(space_id)
    if loaded is None:
        reconciled = reconcile_compiled(
            items,
            schemas=set(),
            steps=set(),
            sequences=set(),
            consoles=set(),
        )
    else:
        reconciled = reconcile_compiled(
            items,
            schemas=loaded["schemas"],
            steps=loaded["steps"],
            sequences=loaded["sequences"],
            consoles=loaded["consoles"],
            records=load_space_records(space_id, items),
        )
    return {**reconciled, "brief": apply_name_check(brief, reconciled)}


def validation_problems(principal: Any, space_id: str, items: list[dict[str, Any]]) -> list[str]:
    problems = chat_apply.validate_batch(principal, space_id, items)
    problems.extend(
        problem
        for problem in chat_apply.input_inventory_problems(items)
        if chat_apply.input_problem_blocks_accept(problem)
    )
    return problems


def is_build_kind(kind: str) -> bool:
    return kind in _BUILD_KINDS
