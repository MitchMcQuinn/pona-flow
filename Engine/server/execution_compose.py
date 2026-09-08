"""
EXECUTION package composer.

Walks a sequence's STEP chain (including nested operations/sequences and the
sequences referenced by relationship conditions) and produces a JSON package
matching ``Docs/EXECUTION-package.schema.json``. The package is persisted in the
catalog ``state`` table for the executor (``execution_run``) to run.

Data sources
------------
- STEP entities (id, attributive_label, payload, parameters) come from the
  per-space SQLite ``entities`` table.
- POINTS_TO topology and relationship conditions come from Neo4j (the only place
  ``condition``/``condition_type`` are stored).
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Iterator

from . import catalog
from . import cypher_utils
from . import execution_join
from . import execution_loop
from . import graph
from . import local_llms
from . import sequence_scope
from . import spaces

# A sequence read query matches its initial STEP node by attributive_label, e.g.
#   MATCH (alias:STEP { attributive_label: 'STEP_LABEL' }) RETURN *
# Also accept a single stored string (legacy / non-array cypher column).
_STEP_ATTR_LABEL_RE = re.compile(
    r":STEP\s*\{[^}]*?attributive_label\s*:\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)

_VALUE_TYPES = (
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "UID",
    "radio",
    "checkbox",
)

# A relationship pattern (``-[``) means the sequence walks past its initial STEP
# (see cypher_utils.cypher_has_step_hop). How *far* it walks is decided by
# sequence_scope, which reads the drawn path rather than just its presence.
_cypher_has_step_hop = cypher_utils.cypher_has_step_hop


def _parse_initial_step_label(cypher: Any) -> str | None:
    """Return the attributive_label of the first STEP node matched in a query package."""
    statements = cypher if isinstance(cypher, list) else [cypher] if isinstance(cypher, str) else []
    for stmt in statements:
        match = _STEP_ATTR_LABEL_RE.search(str(stmt or ""))
        if match:
            return match.group(1).strip()
    return None


def _normalize_value_type(value: Any) -> str:
    text = str(value or "").strip()
    return text if text in _VALUE_TYPES else "string"


def _normalize_choice_options(raw: Any) -> list[str]:
    """Trim/dedupe configured radio/checkbox options, dropping empties."""
    if not isinstance(raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for opt in raw:
        text = str(opt or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _normalize_choice_count(raw: Any) -> int | None:
    """Coerce a checkbox min/max choice count to a non-negative int, else None."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= 0 else None
    if isinstance(raw, float) and raw.is_integer() and raw >= 0:
        return int(raw)
    if isinstance(raw, str) and raw.strip().isdigit():
        return int(raw.strip())
    return None


def _to_step_parameters(raw: Any) -> list[dict[str, Any]]:
    """Convert stored parameter rows to EXECUTION ``stepParameter`` objects."""
    out: list[dict[str, Any]] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        value_type = _normalize_value_type(entry.get("value_type"))
        param: dict[str, Any] = {
            "name": name,
            "is_required": bool(entry.get("is_required")),
            "value_type": value_type,
        }
        fmt = entry.get("format")
        if value_type == "string" and fmt and str(fmt).strip():
            param["format"] = str(fmt).strip()
        if value_type in ("radio", "checkbox"):
            param["options"] = _normalize_choice_options(entry.get("options"))
            if value_type == "checkbox":
                min_choices = _normalize_choice_count(entry.get("min_choices"))
                if min_choices is not None:
                    param["min_choices"] = min_choices
                max_choices = _normalize_choice_count(entry.get("max_choices"))
                if max_choices is not None:
                    param["max_choices"] = max_choices
        # The builder stores a parameter's author-supplied default under ``value``.
        # Carry it through so the run panel can pre-fill it and the executor can
        # fall back to it when no caller value is supplied (e.g. scheduled runs).
        default_value = entry.get("value")
        if default_value is not None and default_value != "":
            param["default_value"] = default_value
        # Create-INSTANCE graph ids declared by the composer: the executor mints a
        # fresh UID per run instead of asking a human (see run_execution).
        if entry.get("auto_generate"):
            param["auto_generate"] = True
        out.append(param)
    return out


def binding_value_empty(value: Any) -> bool:
    """True when a sequence binding should not seed run state."""
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    if isinstance(value, (list, tuple)) and len(value) == 0:
        return True
    return False


def _blocked_binding_names(
    steps: dict[str, dict[str, Any]] | list[dict[str, Any]],
    response_parameters: list[dict[str, Any]],
) -> set[str]:
    """Names that must not be sequence-bound (outputs / minted ids)."""
    blocked: set[str] = set()
    for rp in response_parameters:
        if isinstance(rp, dict):
            blocked.add(str(rp.get("parameter") or "").strip())
    step_list = steps.values() if isinstance(steps, dict) else steps
    for step in step_list:
        if not isinstance(step, dict):
            continue
        for param in step.get("parameters") or []:
            if not isinstance(param, dict) or not param.get("auto_generate"):
                continue
            blocked.add(str(param.get("name") or "").strip())
    blocked.discard("")
    return blocked


def sequence_parameter_values(
    catalog_parameters: Any,
    steps: dict[str, dict[str, Any]] | list[dict[str, Any]],
    response_parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Map of non-empty sequence bindings keyed by parameter name.

    Only names that appear on a step are kept. ``auto_generate`` and
    ``response_parameters`` names are dropped so seeding ``resolved`` cannot
    block minted ids or upstream output bindings.
    """
    step_list = list(steps.values()) if isinstance(steps, dict) else list(steps or [])
    step_names: set[str] = set()
    for step in step_list:
        if not isinstance(step, dict):
            continue
        for param in step.get("parameters") or []:
            if not isinstance(param, dict):
                continue
            name = str(param.get("name") or "").strip()
            if name:
                step_names.add(name)
    blocked = _blocked_binding_names(step_list, response_parameters or [])
    out: dict[str, Any] = {}
    for entry in catalog_parameters or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name or name in out or name not in step_names or name in blocked:
            continue
        value = entry.get("value")
        if binding_value_empty(value):
            continue
        out[name] = value
    return out


def bindable_step_parameters(package: dict[str, Any]) -> list[dict[str, Any]]:
    """STEP inputs a sequence may bake in: not auto_generate, not response-produced."""
    response_names = {
        str(rp.get("parameter") or "").strip()
        for rp in (package.get("response_parameters") or [])
        if isinstance(rp, dict)
    }
    seen: set[str] = set()
    params: list[dict[str, Any]] = []
    for step in package.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for param in step.get("parameters") or []:
            if not isinstance(param, dict) or param.get("auto_generate"):
                continue
            name = str(param.get("name") or "").strip()
            if not name or name in seen or name in response_names:
                continue
            seen.add(name)
            params.append(param)
    return params


def caller_facing_parameters(package: dict[str, Any]) -> list[dict[str, Any]]:
    """Union of step inputs a caller still needs to supply.

    Drops ``auto_generate``, names written by ``response_parameters``, and names
    already baked in via ``parameter_values``.
    """
    bound: set[str] = set()
    raw_values = package.get("parameter_values")
    if isinstance(raw_values, dict):
        bound = {
            str(key).strip()
            for key, value in raw_values.items()
            if str(key).strip() and not binding_value_empty(value)
        }
    return [
        param
        for param in bindable_step_parameters(package)
        if str(param.get("name") or "").strip() not in bound
    ]


def _load_step_entities(space_id: str) -> dict[str, dict[str, Any]]:
    """Return ``{id: {attributive_label, payload, parameters}}`` for STEP entities."""
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        node_label_col = spaces.entities_node_label_column(conn)
        cur = conn.execute(
            f"SELECT id, common_label, payload, parameters FROM entities "
            f"WHERE {node_label_col} = 'STEP'"
        )
        out: dict[str, dict[str, Any]] = {}
        for row in cur.fetchall():
            eid = (row[0] or "").strip()
            if not eid:
                continue
            try:
                parameters = json.loads(row[3] or "[]")
            except (ValueError, TypeError):
                parameters = []
            if not isinstance(parameters, list):
                parameters = []
            out[eid] = {
                "attributive_label": (row[1] or "").strip(),
                "payload": graph._parse_entity_payload(row[2]),
                "parameters": parameters,
            }
        return out
    finally:
        conn.close()


def _load_step_adjacency(
    space_id: str, entities: dict[str, dict[str, Any]] | None = None
) -> dict[str, list[dict[str, Any]]]:
    """
    Return ``{source_id: [{target, attributive_label, condition, condition_type}, ...]}``.

    POINTS_TO topology comes from Neo4j, but a relationship's guard condition is
    read from its entities payload (SQLite) — falling back to the Neo4j-stored value
    for edges created before conditions were relocated to the payload.

    ``attributive_label`` is carried because two STEPs can be joined by more than one
    edge (a shared ``NEXT`` alongside a named one), and a path-scoped sequence names
    the edge it walks, not just the pair it connects.
    """
    cypher = (
        "MATCH (a:STEP)-[r:POINTS_TO]->(b:STEP) "
        "WHERE a.id IS NOT NULL AND b.id IS NOT NULL "
        "RETURN r.id AS id, a.id AS source, b.id AS target, "
        "r.attributive_label AS attributive_label, "
        "r.condition AS condition, r.condition_type AS condition_type"
    )
    entities = entities or {}
    out: dict[str, list[dict[str, Any]]] = {}
    try:
        result = graph.run_cypher_for_space(space_id, cypher, {})
    except Exception:
        return out
    for row in result.get("records") or []:
        source = (row.get("source") or "").strip()
        target = (row.get("target") or "").strip()
        if not source or not target:
            continue
        rel_id = (row.get("id") or "").strip()
        rel_payload = (entities.get(rel_id) or {}).get("payload") or {}
        condition = str(rel_payload.get("condition") or row.get("condition") or "").strip()
        condition_type = str(
            rel_payload.get("condition_type") or row.get("condition_type") or ""
        ).strip()
        edge: dict[str, Any] = {
            "target": target,
            "attributive_label": str(row.get("attributive_label") or "").strip(),
            "condition": condition,
            "condition_type": condition_type,
        }
        # Optional expected-result branch flag (parameter conditions only); stored
        # only in the SQLite payload.
        if isinstance(rel_payload.get("condition_expected"), bool):
            edge["condition_expected"] = rel_payload["condition_expected"]
        out.setdefault(source, []).append(edge)
    return out


# Value types for the optional Local LLM setting overrides, mirroring the authoring
# declarations in App/authoring/src/parameterRefs.ts. Which keys exist is owned by
# local_llms.OVERRIDE_KEYS; this map only says how each one is collected.
_LOCAL_LLM_OVERRIDE_VALUE_TYPES = {
    "system_prompt": "string",
    "response_format": "radio",
    "json_schema": "string",
    "temperature": "number",
    "top_p": "number",
    "top_k": "integer",
    "min_p": "number",
    "repeat_penalty": "number",
    "num_ctx": "integer",
    "num_predict": "integer",
    "seed": "integer",
    "stop": "array",
}
_LOCAL_LLM_RESPONSE_FORMAT_OPTIONS = ("text", "json_schema")


def _local_llm_override_param(name: str) -> dict[str, Any]:
    param: dict[str, Any] = {
        "name": name,
        "value_type": _LOCAL_LLM_OVERRIDE_VALUE_TYPES[name],
        "is_required": False,
    }
    if name == "response_format":
        param["options"] = list(_LOCAL_LLM_RESPONSE_FORMAT_OPTIONS)
    return param


def _ensure_local_llm_params(parameters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Local LLM steps always expose ``prompt`` plus the optional setting overrides.

    ``prompt`` is forced required so interactive runs pause for it; the overrides stay
    optional and fall back to the saved config when left blank. Injecting the missing
    ones here means STEP entities saved before these parameters existed still accept
    them, while author-saved rows keep their own default value.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for param in parameters:
        pname = str(param.get("name") or "").strip()
        merged = dict(param)
        if pname == "prompt":
            merged["name"] = pname
            merged["is_required"] = True
            if not str(merged.get("value_type") or "").strip():
                merged["value_type"] = "string"
        elif pname in _LOCAL_LLM_OVERRIDE_VALUE_TYPES:
            merged["name"] = pname
            merged["is_required"] = False
            merged["value_type"] = _LOCAL_LLM_OVERRIDE_VALUE_TYPES[pname]
            if pname == "response_format":
                merged["options"] = list(_LOCAL_LLM_RESPONSE_FORMAT_OPTIONS)
        if pname:
            seen.add(pname)
        out.append(merged)
    if "prompt" not in seen:
        out.insert(
            0,
            {
                "name": "prompt",
                "value_type": "string",
                "value": "",
                "is_required": True,
                "description": "Prompt sent to the local LLM.",
            },
        )
    for name in local_llms.OVERRIDE_KEYS:
        if name not in seen:
            out.append(_local_llm_override_param(name))
    return out


def _transition_condition_parameter(edge: dict[str, Any]) -> str:
    """A transition's gate is the parameter named on the relationship condition."""
    if edge.get("condition_type") == "parameter":
        return str(edge.get("condition") or "").lstrip("$").strip()
    return ""


def _transition_condition_expected(edge: dict[str, Any]) -> bool | None:
    """The boolean a parameter-gated transition expects, or None for legacy truthy gating."""
    if edge.get("condition_type") == "parameter" and isinstance(
        edge.get("condition_expected"), bool
    ):
        return edge["condition_expected"]
    return None


def _attach_call_policy(step: dict[str, Any], payload: dict[str, Any]) -> None:
    """Copy HTTP/LLM timeout and retry fields from the entity payload onto the composed step."""
    for key in ("timeout_seconds", "max_attempts", "backoff_seconds"):
        if key not in payload:
            continue
        value = payload.get(key)
        if value is None or value == "":
            continue
        step[key] = value


def _build_step(
    node_id: str,
    entity: dict[str, Any],
    adjacency: dict[str, list[dict[str, Any]]],
    fetch_query: Any = None,
    allow_edge: Any = None,
) -> dict[str, Any]:
    fetch_query = fetch_query or catalog.fetch_query_for_compose
    payload = entity.get("payload") or {}
    query_id = str(payload.get("query_id") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    resource_id = str(payload.get("resource_id") or "").strip()
    endpoint = str(payload.get("endpoint") or "")
    method = str(payload.get("method") or "POST")
    headers = payload.get("headers")
    if not isinstance(headers, dict):
        headers = {}
    body = payload.get("body")
    if not isinstance(body, dict):
        body = {}

    if query_id:
        referenced = fetch_query(query_id)
        # Nested sequences carry their parameters on their own steps; an operation
        # contributes its parameter definitions to this step.
        if referenced and referenced.get("kind") != "sequence":
            parameters = _to_step_parameters(referenced.get("parameters"))
        else:
            parameters = []
    else:
        # Custom endpoint: parameters are mirrored on the STEP entity row.
        parameters = _to_step_parameters(entity.get("parameters"))

    transitions = []
    for edge in adjacency.get(node_id, []):
        # A path-scoped sequence owns only the edges it drew. Filtering here rather
        # than after the fact keeps the relationship's attributive_label in hand,
        # which is the only way to tell two edges between the same pair apart.
        if allow_edge is not None and not allow_edge(node_id, edge):
            continue
        transition: dict[str, Any] = {
            "id": edge["target"],
            "condition_parameter": _transition_condition_parameter(edge),
        }
        expected = _transition_condition_expected(edge)
        if expected is not None:
            transition["condition_expected"] = expected
        transitions.append(transition)

    step: dict[str, Any] = {
        "id": node_id,
        "query_id": query_id,
        "endpoint": endpoint,
        "method": method,
        "headers": headers,
        "body": body,
        "parameters": parameters,
        "next": transitions,
    }
    if kind == "code":
        # Leftover code-execution STEP (feature archived). Keep kind so the
        # executor can refuse it instead of treating it as an empty HTTP call.
        step["kind"] = "code"
        step["resource_id"] = resource_id
    elif kind == "local_llm":
        step["kind"] = "local_llm"
        step["config_id"] = str(payload.get("config_id") or "").strip()
        # Always require ``prompt`` and expose the optional setting overrides, even
        # when the STEP entity was saved before those parameters were declared.
        step["parameters"] = _ensure_local_llm_params(parameters)
        _attach_call_policy(step, payload)
    elif kind == "wait":
        step["kind"] = "wait"
        mode = str(payload.get("mode") or "duration").strip() or "duration"
        step["wait_mode"] = mode
        if mode == "until":
            step["until"] = str(payload.get("until") or "").strip()
        elif mode == "event":
            step["event_id"] = str(payload.get("event_id") or "").strip()
        else:
            step["duration_seconds"] = payload.get("duration_seconds", 0)
    elif kind == "join":
        step["kind"] = "join"
    else:
        _attach_call_policy(step, payload)
    return step


def _step_return_aliases(payload: dict[str, Any], fetch_query: Any) -> list[str]:
    """
    Names a step publishes into run state, in binding order.

    For an operation-backed step those are its scalar RETURN aliases (the executor
    binds them automatically) plus ``ok`` after a successful query; for an
    endpoint/LLM/wait step they are ``ok`` (and HTTP ``status``) plus the
    parameters its ``response_parameters`` mappings write. Together this is the
    vocabulary a loop condition or for-each source may draw on.
    """
    names: list[str] = []
    seen: set[str] = set()

    def add(name: Any) -> None:
        text = str(name or "").strip()
        if text and text not in seen:
            seen.add(text)
            names.append(text)

    query_id = str(payload.get("query_id") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    if query_id:
        referenced = fetch_query(query_id)
        if referenced and referenced.get("kind") != "sequence":
            for alias in cypher_utils.return_aliases(referenced.get("cypher") or []):
                add(alias)
        add("ok")
    elif kind in ("local_llm", "wait", "join", "code"):
        add("ok")
    else:
        add("ok")
        add("status")
    for rp in payload.get("response_parameters") or []:
        if isinstance(rp, dict):
            add(rp.get("parameter"))
    return names


def _loop_referenceable_names(
    seq: dict[str, Any],
    steps: dict[str, dict[str, Any]],
    available_parameters: list[dict[str, Any]],
) -> set[str]:
    """Every name a loop condition may test: inputs plus published outputs."""
    names: set[str] = set()
    for param in seq.get("parameters") or []:
        if isinstance(param, dict):
            names.add(str(param.get("name") or "").strip())
    for step in steps.values():
        for param in step.get("parameters") or []:
            if isinstance(param, dict):
                names.add(str(param.get("name") or "").strip())
    for entry in available_parameters:
        for alias in entry.get("aliases") or []:
            names.add(str(alias or "").strip())
    names.discard("")
    return names


def _alias_source_steps(available_parameters: list[dict[str, Any]]) -> dict[str, str]:
    """Map each published name to the first step that publishes it.

    First wins because compose order is run order: when two steps project the same
    alias, a for-each should iterate the rows of the one that runs first.
    """
    out: dict[str, str] = {}
    for entry in available_parameters:
        step_id = str(entry.get("step_id") or "").strip()
        for alias in entry.get("aliases") or []:
            name = str(alias or "").strip()
            if name and name not in out:
                out[name] = step_id
    return out


class _StepWalk:
    """Shared BFS mechanics over a sequence's STEP graph.

    :func:`compose_execution_package` and :func:`enumerate_sequence_operation_ids`
    walk the same structure (initial STEP from the read query's label → POINTS_TO
    chain when the query traverses downstream → nested sequences by query_id) but
    do different work per node and apply different policy gates. This object owns
    the loading, label→id resolution, queue, and visited bookkeeping; callers drive
    expansion so their original enqueue order is preserved exactly.
    """

    def __init__(self, space_id: str, root_query_id: str) -> None:
        self.entities = _load_step_entities(space_id)
        self.adjacency = _load_step_adjacency(space_id, self.entities)
        self._label_to_id = {
            ent["attributive_label"]: eid
            for eid, ent in self.entities.items()
            if ent.get("attributive_label")
        }
        # Display titles and UPPER_SNAKE forms of one name must resolve to the same
        # node ("Call Discord …" ↔ CALL_DISCORD_…), so labels are also indexed
        # normalized for the lookups that come from a saved snapshot.
        self._normalized_label_to_id = {
            cypher_utils.normalize_attributive_label(label): eid
            for label, eid in self._label_to_id.items()
        }
        self.queue: list[str] = []
        self.visited_steps: set[str] = set()
        self.visited_sequences: set[str] = {(root_query_id or "").strip()}
        # Populated for a path-scoped sequence; None leaves every edge allowed.
        self._allowed_edges: set[tuple[str, str, str]] | None = None
        self._allowed_pairs: set[tuple[str, str]] | None = None

    def step_id_for_label(self, label: str) -> str | None:
        name = (label or "").strip()
        if not name:
            return None
        return self._label_to_id.get(name) or self._normalized_label_to_id.get(
            cypher_utils.normalize_attributive_label(name)
        )

    def initial_step_id(self, cypher: list[Any]) -> str | None:
        """The step id matched by a sequence read query's initial STEP label."""
        label = _parse_initial_step_label(cypher or [])
        return self.step_id_for_label(label) if label else None

    def enqueue_initial(self, cypher: list[Any]) -> None:
        initial = self.initial_step_id(cypher)
        if initial:
            self.queue.append(initial)

    def enqueue_scope(self, scope: dict[str, Any], cypher: list[Any]) -> None:
        """Seed the walk from a resolved sequence scope.

        In ``path`` mode the declared steps are enqueued up front and the edge filter
        is armed, so the walk never leaves the drawn path — no chain continuation is
        needed or wanted. The other modes keep the historical entry-label seed.
        """
        if scope.get("mode") != sequence_scope.MODE_PATH:
            self.enqueue_initial(cypher)
            return

        allowed_edges: set[tuple[str, str, str]] = set()
        allowed_pairs: set[tuple[str, str]] = set()
        for source_label, target_label, rel_label in scope.get("edges") or []:
            source_id = self.step_id_for_label(source_label)
            target_id = self.step_id_for_label(target_label)
            if not source_id or not target_id:
                continue
            if rel_label == sequence_scope.WILDCARD_RELATIONSHIP:
                allowed_pairs.add((source_id, target_id))
            else:
                allowed_edges.add(
                    (
                        source_id,
                        target_id,
                        cypher_utils.normalize_attributive_label(rel_label),
                    )
                )
        self._allowed_edges = allowed_edges
        self._allowed_pairs = allowed_pairs

        for label in scope.get("step_labels") or []:
            step_id = self.step_id_for_label(label)
            if step_id:
                self.queue.append(step_id)

    def allow_edge(self, node_id: str, edge: dict[str, Any]) -> bool:
        """Whether a graph edge belongs to this sequence's declared walk."""
        if self._allowed_edges is None:
            return True
        target = str(edge.get("target") or "").strip()
        if (node_id, target) in (self._allowed_pairs or set()):
            return True
        label = cypher_utils.normalize_attributive_label(
            str(edge.get("attributive_label") or "")
        )
        return (node_id, target, label) in self._allowed_edges

    def enqueue_targets(self, node_id: str) -> None:
        """Enqueue the node's outgoing POINTS_TO targets (chain continuation)."""
        for edge in self.adjacency.get(node_id, []):
            self.queue.append(edge["target"])

    def steps(self) -> Iterator[tuple[str, dict[str, Any]]]:
        """Yield each reachable ``(node_id, entity)`` once, in queue order."""
        while self.queue:
            node_id = self.queue.pop(0)
            if not node_id or node_id in self.visited_steps:
                continue
            self.visited_steps.add(node_id)
            entity = self.entities.get(node_id)
            if not entity:
                continue
            yield node_id, entity


def compose_execution_package(space_id: str, sequence_query_id: str) -> dict[str, Any]:
    """
    Build an EXECUTION package for a sequence by walking its STEP chain.

    Nested sequences (referenced by a step's ``query_id`` or by a relationship's
    query condition) are expanded into the same flat ``steps`` array so the
    executor has all data without further catalog lookups.
    """
    sid = (space_id or "").strip()
    seq = catalog.fetch_query_for_compose(sequence_query_id)
    if not seq:
        return {"steps": [], "response_parameters": []}

    # Enforce catalog runtime policy: a sequence may only be composed/run when it is
    # both runtime-enabled and triggerable (see Docs/DECISIONS.md). These flags were
    # previously stored but never enforced.
    if not int(seq.get("runtime_enabled", 1)):
        raise PermissionError(
            f"Sequence {sequence_query_id!r} is not runtime-enabled and cannot be run."
        )
    if seq.get("kind") == "sequence" and not int(seq.get("triggerable", 1)):
        raise PermissionError(
            f"Sequence {sequence_query_id!r} is not triggerable and cannot be run."
        )
    # A suspended sequence has an INSTANCE step that no longer matches its SCHEMA pattern
    # (a SCHEMA was changed). It must not run for users or agents until the step is re-saved.
    if seq.get("kind") == "sequence" and int(seq.get("suspended", 0)):
        raise PermissionError(
            f"Sequence {sequence_query_id!r} is suspended: a SCHEMA change invalidated one of "
            "its INSTANCE steps. Re-save the affected step to match the new SCHEMA pattern."
        )

    walk = _StepWalk(sid, sequence_query_id)

    steps: dict[str, dict[str, Any]] = {}
    response_parameters: list[dict[str, Any]] = []
    seen_response: set[tuple[str, str]] = set()
    available_parameters: list[dict[str, Any]] = []
    query_cache: dict[str, dict[str, Any] | None] = {}

    def fetch_query(query_id: str) -> dict[str, Any] | None:
        """Catalog lookup memoized for the life of this compose."""
        qid = (query_id or "").strip()
        if not qid:
            return None
        if qid not in query_cache:
            query_cache[qid] = catalog.fetch_query_for_compose(qid)
        return query_cache[qid]

    def reject_nested_sequence(query_id: str, label: str) -> None:
        """A STEP whose operation is another sequence is not runnable.

        Nesting used to be flattened into this package, but a nested chain has its
        own entry point and (now) its own loop policy, which cannot be reconciled
        with the parent's single cycle. Authoring hides sequence-backed STEPs from
        the picker; this is the backstop for a graph edited elsewhere.
        """
        qid = (query_id or "").strip()
        if not qid or qid in walk.visited_sequences:
            return
        referenced = fetch_query(qid)
        if not referenced or referenced.get("kind") != "sequence":
            return
        raise ValueError(
            f"Step {label or qid!r} runs the sequence {referenced.get('name') or qid!r}. "
            "Nested sequences are not supported — point this step at an operation, or "
            "inline that sequence's steps into this one."
        )

    # What the sequence declared: one step, an explicit path, or an open downstream
    # walk. STEP nodes and their POINTS_TO edges are shared, so this is what keeps one
    # sequence's chain (and its cycle) out of another's package.
    scope = sequence_scope.resolve_sequence_scope(seq)
    walk.enqueue_scope(scope, seq.get("cypher") or [])
    traverse = scope.get("mode") == sequence_scope.MODE_OPEN

    for node_id, entity in walk.steps():
        steps[node_id] = _build_step(
            node_id, entity, walk.adjacency, fetch_query, walk.allow_edge
        )

        payload = entity.get("payload") or {}
        # Names this step can publish into run state, so a loop condition or a
        # for-each source can be checked at compose time and offered in the builder.
        aliases = _step_return_aliases(payload, fetch_query)
        if aliases:
            available_parameters.append(
                {
                    "step_id": node_id,
                    "label": str(entity.get("attributive_label") or ""),
                    "aliases": aliases,
                }
            )

        for rp in payload.get("response_parameters") or []:
            if not isinstance(rp, dict):
                continue
            property_path = str(rp.get("property_path") or "").strip()
            parameter = str(rp.get("parameter") or "").strip()
            if not property_path or not parameter:
                continue
            key = (property_path, parameter)
            if key in seen_response:
                continue
            seen_response.add(key)
            mapping: dict[str, Any] = {"property_path": property_path, "parameter": parameter}
            default_value = rp.get("default_value")
            if default_value is not None and str(default_value).strip():
                mapping["default_value"] = str(default_value)
            response_parameters.append(mapping)

        if traverse:
            # Continue along the chain.
            walk.enqueue_targets(node_id)

        # A step whose operation is itself a sequence is rejected outright.
        reject_nested_sequence(
            str(payload.get("query_id") or ""),
            str(entity.get("attributive_label") or ""),
        )

    # Transitions may exist between STEPs that belong to other sequences on the same
    # graph, so drop any that point at steps outside this sequence's scope — otherwise a
    # single-step sequence would advance into another sequence's steps that aren't part
    # of this package.
    in_scope = set(steps.keys())
    for step in steps.values():
        step["next"] = [
            transition
            for transition in step.get("next") or []
            if transition.get("id") in in_scope
        ]

    package: dict[str, Any] = {"steps": list(steps.values())}
    if response_parameters:
        package["response_parameters"] = response_parameters
    if available_parameters:
        package["available_parameters"] = available_parameters
    parameter_values = sequence_parameter_values(
        seq.get("parameters") if seq.get("kind") == "sequence" else [],
        steps,
        response_parameters,
    )
    if parameter_values:
        package["parameter_values"] = parameter_values

    # The graph supplies the cycle; loop_config supplies the rule that ends it. A
    # `dag` sequence yields no descriptor, so the executor keeps its single-pass walk.
    loop_config = seq.get("loop_config") if seq.get("kind") == "sequence" else None
    alias_steps = _alias_source_steps(available_parameters)
    problems = execution_loop.validate_loop_config(
        execution_loop.normalize_loop_config(loop_config),
        _loop_referenceable_names(seq, steps, available_parameters),
        iterable=set(alias_steps),
    )
    if problems:
        raise ValueError(" ".join(problems))
    loop = execution_loop.analyze_loop(
        steps, loop_config, next(iter(steps), None), alias_steps
    )
    execution_join.reject_join_policy(steps, loop)
    if loop:
        package["loop"] = loop
        collect_aliases: list[str] = []
        seen_collect: set[str] = set()
        for item in loop.get("collect") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("as") or "").strip()
            if name and name not in seen_collect:
                seen_collect.add(name)
                collect_aliases.append(name)
        if collect_aliases:
            available_parameters.append(
                {"step_id": "", "label": "loop", "aliases": collect_aliases}
            )
            package["available_parameters"] = available_parameters
    return package


def preview_sequence_parameters(
    space_id: str,
    entry_step: str,
    traversal: str = "downstream",
) -> list[dict[str, Any]]:
    """Caller-facing STEP inputs reachable from ``entry_step``, without a catalog row.

    Used by the create-sequence builder and MCP authoring to bind values before
    the sequence exists. ``traversal`` of ``single`` walks only the entry STEP;
    anything else follows outgoing ``POINTS_TO`` (open downstream).
    """
    sid = (space_id or "").strip()
    label = (entry_step or "").strip()
    if not sid or not label:
        return []
    walk = _StepWalk(sid, "")
    step_id = walk.step_id_for_label(label)
    if not step_id:
        return []
    walk.queue.append(step_id)
    traverse = (traversal or "downstream").strip() != "single"

    steps: dict[str, dict[str, Any]] = {}
    response_parameters: list[dict[str, Any]] = []
    seen_response: set[tuple[str, str]] = set()
    query_cache: dict[str, dict[str, Any] | None] = {}

    def fetch_query(query_id: str) -> dict[str, Any] | None:
        qid = (query_id or "").strip()
        if not qid:
            return None
        if qid not in query_cache:
            query_cache[qid] = catalog.fetch_query_for_compose(qid)
        return query_cache[qid]

    for node_id, entity in walk.steps():
        steps[node_id] = _build_step(
            node_id, entity, walk.adjacency, fetch_query, walk.allow_edge
        )
        payload = entity.get("payload") or {}
        for rp in payload.get("response_parameters") or []:
            if not isinstance(rp, dict):
                continue
            property_path = str(rp.get("property_path") or "").strip()
            parameter = str(rp.get("parameter") or "").strip()
            if not property_path or not parameter:
                continue
            key = (property_path, parameter)
            if key in seen_response:
                continue
            seen_response.add(key)
            response_parameters.append(
                {"property_path": property_path, "parameter": parameter}
            )
        if traverse:
            walk.enqueue_targets(node_id)

    package: dict[str, Any] = {"steps": list(steps.values())}
    if response_parameters:
        package["response_parameters"] = response_parameters
    return bindable_step_parameters(package)


def preview_sequence_inputs(
    space_id: str,
    sequence_id: str | None = None,
    entry_step: str | None = None,
    traversal: str = "downstream",
) -> dict[str, Any]:
    """Discover bindable STEP inputs for a saved sequence or an unsaved entry STEP.

    A ``sequence_id`` uses the same compose walk as a run (path/open/single). When
    compose fails and ``entry_step`` is supplied, falls back to the unsaved walk.
    """
    sid = (space_id or "").strip()
    seq_id = (sequence_id or "").strip()
    label = (entry_step or "").strip()
    if seq_id:
        try:
            package = compose_execution_package(sid, seq_id)
            return {
                "parameters": bindable_step_parameters(package),
                "parameter_values": dict(package.get("parameter_values") or {}),
            }
        except Exception:
            if not label:
                raise
    return {
        "parameters": preview_sequence_parameters(sid, label, traversal),
        "parameter_values": {},
    }


def enumerate_sequence_operation_ids(space_id: str, sequence_query_id: str) -> set[str]:
    """Collect every catalog ``query_id`` a sequence's STEP chain references — *no* policy gates.

    This shares :func:`compose_execution_package`'s graph traversal (via
    :class:`_StepWalk`) but skips the runtime/triggerable/suspended checks so it can
    introspect a sequence even while suspended. Used by the SCHEMA-update suspension
    cascade to test whether a sequence references an INSTANCE operation invalidated by
    a schema change.
    """
    sid = (space_id or "").strip()
    root = (sequence_query_id or "").strip()
    seq = catalog.fetch_query_for_compose(root)
    if not seq:
        return set()

    walk = _StepWalk(sid, root)
    operation_ids: set[str] = set()

    scope = sequence_scope.resolve_sequence_scope(seq)
    walk.enqueue_scope(scope, seq.get("cypher") or [])
    traverse = scope.get("mode") == sequence_scope.MODE_OPEN

    for node_id, entity in walk.steps():
        payload = entity.get("payload") or {}
        query_id = str(payload.get("query_id") or "").strip()
        if query_id:
            operation_ids.add(query_id)
            # A step whose operation is itself a sequence expands into this sequence's scope.
            nested = catalog.fetch_query_for_compose(query_id)
            if (
                nested
                and nested.get("kind") == "sequence"
                and query_id not in walk.visited_sequences
            ):
                walk.visited_sequences.add(query_id)
                walk.enqueue_initial(nested.get("cypher") or [])
        if traverse:
            walk.enqueue_targets(node_id)

    return operation_ids


def compose_and_store(
    space_id: str, sequence_query_id: str, owner_id: str | None = None
) -> dict[str, Any]:
    """Compose a sequence's EXECUTION package and persist it as an inactive state row.

    ``owner_id`` (the requesting user) scopes the package so that re-composing the
    same sequence replaces that client's previous unrun package instead of leaving
    a dead row behind. The scheduler composes without an owner and runs immediately,
    so it skips replacement.
    """
    package = compose_execution_package(space_id, sequence_query_id)
    seq_id = (sequence_query_id or "").strip()
    sid = (space_id or "").strip()
    oid = (owner_id or "").strip()
    # Record the originating sequence id so the executor can write an audit_log entry,
    # plus the owner/space so compose can scope its replace-previous cleanup.
    package["sequence_query_id"] = seq_id
    package["space_id"] = sid
    if oid:
        package["owner_id"] = oid
        # Replace this client's prior composed-but-unrun package for this sequence so
        # repeatedly selecting a sequence doesn't accumulate dead rows in `state`.
        try:
            catalog.delete_unrun_state_packages(seq_id, owner_id=oid, space_id=sid)
        except Exception as cleanup_err:  # cleanup must never block composing
            sys.stderr.write(f"compose-cleanup error: {cleanup_err}\n")
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    return {"state_id": state_id, "package": package}
