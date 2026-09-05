"""
What a sequence's saved read query declares about the walk it runs.

A sequence used to contribute exactly two facts to composition: the entry STEP's
attributive_label, and whether the Cypher contained a relationship pattern at all.
The hops an author drew were discarded, so any multi-hop sequence expanded into
"every ``POINTS_TO`` edge reachable from the entry". STEP nodes are shared between
sequences, so that pulled in edges belonging to other sequences — two cycles through
one STEP would land in the same package and the run would be rejected for having
more than one loop.

The drawn path was never lost, only unused: ``builder_config`` stores the whole
QueryObject, including each hop's relationship ``attributive_label`` and the
``alias_mode: "reference"`` node that closes a self-loop. This module reads that
snapshot back and reports one of three modes:

``single``
    One STEP node, no hops. The package is that step alone.
``path``
    Explicit hops. The package is exactly the named steps and the named edges —
    the case that used to over-expand.
``open``
    The "Return downstream" toggle (``read_traversal``), or a variable-length hop.
    Walk everything downstream, which is what the author asked for.

A row without a usable ``builder_config`` (template imports, anything authored
before the snapshot was stored) falls back to the old Cypher predicate, so its
behavior is unchanged.
"""

from __future__ import annotations

import json
from typing import Any

from . import cypher_utils

MODE_SINGLE = "single"
MODE_PATH = "path"
MODE_OPEN = "open"

# A relationship the author left unnamed, or named with a $parameter we cannot resolve
# to a concrete edge. Recorded as this sentinel and matched against any POINTS_TO
# between the two steps rather than dropped, which would silently break the chain.
WILDCARD_RELATIONSHIP = ""

# Only STEP match clauses describe a sequence's walk. A sequence read query is
# STEP-only in practice, but the snapshot format allows other labels.
_STEP_CLAUSE_LABEL = "STEP"

# read_traversal values that render a variable-length pattern (see
# App/composer/src/render/traversal.ts). Both mean "walk outward from this node".
_OPEN_TRAVERSAL_MODES = ("downstream", "network")


def _as_dict(value: Any) -> dict[str, Any]:
    """Parse a stored JSON object column that may arrive as text or already decoded."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _label_of(entity: Any) -> str:
    if not isinstance(entity, dict):
        return ""
    return str(entity.get("attributive_label") or "").strip()


def _is_parameter_label(label: str) -> bool:
    """``$name`` stands in for a label chosen at run time, so it names no fixed node."""
    return label.startswith("$")


def _step_clauses(query: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        clause
        for clause in query.get("match") or []
        if isinstance(clause, dict) and str(clause.get("label") or "") == _STEP_CLAUSE_LABEL
    ]


def _define_labels(clauses: list[dict[str, Any]]) -> dict[str, str]:
    """``{variable: attributive_label}`` for every node the query *defines*.

    Reference nodes carry a copy of the label today, but the defining occurrence is
    the authoritative one — a reference is only ever a pointer at it.
    """
    out: dict[str, str] = {}
    for clause in clauses:
        for pattern in clause.get("patterns") or []:
            if not isinstance(pattern, dict):
                continue
            for element in pattern.get("path") or []:
                if not isinstance(element, dict) or element.get("kind") != "node":
                    continue
                node = element.get("node")
                if not isinstance(node, dict):
                    continue
                if node.get("alias_mode") == "reference":
                    continue
                variable = str(node.get("variable") or "").strip()
                label = _label_of(node)
                if variable and label and variable not in out:
                    out[variable] = label
    return out


def _resolve_node_label(node: Any, defines: dict[str, str]) -> str:
    """The attributive_label a path node stands for, following alias references."""
    if not isinstance(node, dict):
        return ""
    if node.get("alias_mode") == "reference":
        ref = str(node.get("alias_ref") or node.get("variable") or "").strip()
        resolved = defines.get(ref, "")
        if resolved:
            return resolved
    return _label_of(node)


def _relationship_is_variable_length(relationship: Any) -> bool:
    if not isinstance(relationship, dict):
        return False
    length = relationship.get("length")
    if not isinstance(length, dict):
        return False
    return any(
        length.get(bound) not in (None, "") for bound in ("min", "max")
    )


def _relationship_label(relationship: Any) -> str:
    label = _label_of(relationship)
    return WILDCARD_RELATIONSHIP if _is_parameter_label(label) else label


def _scope(mode: str, step_labels: list[str] | None = None, edges: list | None = None) -> dict:
    labels = step_labels or []
    return {
        "mode": mode,
        "entry_label": labels[0] if labels else "",
        "step_labels": labels,
        "edges": edges or [],
    }


def _fallback_scope(cypher: Any) -> dict[str, Any]:
    """
    Pre-``builder_config`` behavior: any relationship pattern means walk everything.

    A named hop does not really ask for an open walk, but with no snapshot there is no
    edge list to scope to, and widening is the safe direction — truncating the row to
    one step would silently drop steps from a sequence that runs today.
    """
    if cypher_utils.cypher_has_step_hop(cypher):
        return _scope(MODE_OPEN)
    return _scope(MODE_SINGLE)


def resolve_sequence_scope(seq_row: Any) -> dict[str, Any]:
    """
    The steps and edges a sequence declares, as ``{mode, entry_label, step_labels, edges}``.

    ``seq_row`` is a catalog row carrying ``builder_config`` and ``cypher`` (either
    ``catalog.fetch_query_for_compose`` or ``catalog.fetch_query_package``).

    ``edges`` is populated only for ``path`` mode, as
    ``(source_label, target_label, relationship_label)`` triples where an empty
    relationship label matches any ``POINTS_TO`` between that pair. ``step_labels``
    comes back whenever the snapshot was readable, but an ``open`` walk is by
    definition not bounded by it, and callers resolve the other two modes from the
    entry label they already parse out of the Cypher.

    Never raises. A snapshot this cannot read degrades to the legacy Cypher
    predicate, so an unrecognized shape can only ever restore the old behavior —
    it cannot make a sequence unrunnable.
    """
    row = seq_row if isinstance(seq_row, dict) else {}
    cypher = row.get("cypher") or []
    query = _as_dict(_as_dict(row.get("builder_config")).get("query"))
    if not query:
        return _fallback_scope(cypher)

    if str(query.get("read_traversal") or "").strip() in _OPEN_TRAVERSAL_MODES:
        return _scope(MODE_OPEN)

    clauses = _step_clauses(query)
    if not clauses:
        return _fallback_scope(cypher)

    defines = _define_labels(clauses)
    step_labels: list[str] = []
    edges: list[tuple[str, str, str]] = []
    saw_relationship = False
    unresolved = False

    for clause in clauses:
        for pattern in clause.get("patterns") or []:
            if not isinstance(pattern, dict):
                continue
            previous_label = ""
            pending: dict[str, Any] | None = None
            for element in pattern.get("path") or []:
                if not isinstance(element, dict):
                    continue
                if element.get("kind") == "relationship":
                    relationship = element.get("relationship")
                    saw_relationship = True
                    # A variable-length hop is the author asking for an open walk in
                    # the middle of a path; there is no fixed edge set to scope to.
                    if _relationship_is_variable_length(relationship):
                        return _scope(MODE_OPEN)
                    pending = relationship if isinstance(relationship, dict) else {}
                    continue
                if element.get("kind") != "node":
                    continue
                label = _resolve_node_label(element.get("node"), defines)
                if not label or _is_parameter_label(label):
                    # A node we cannot pin to a graph STEP makes the whole path
                    # untrustworthy, so fall back rather than compose a partial walk.
                    unresolved = True
                    pending = None
                    previous_label = ""
                    continue
                if label not in step_labels:
                    step_labels.append(label)
                if pending is not None and previous_label:
                    edge = (previous_label, label, _relationship_label(pending))
                    if str(pending.get("direction") or "") == "incoming":
                        edge = (label, previous_label, edge[2])
                    if edge not in edges:
                        edges.append(edge)
                pending = None
                previous_label = label

    if unresolved:
        return _fallback_scope(cypher)
    if not saw_relationship:
        # A snapshot recording no hop whose composed Cypher nonetheless traverses is
        # stale. The Cypher is what described the run before snapshots were read, so
        # believe it rather than truncating the sequence to its entry step.
        if cypher_utils.cypher_walks_open_downstream(cypher):
            return _scope(MODE_OPEN)
        return _scope(MODE_SINGLE, step_labels)
    if not edges:
        # Relationships were drawn but none survived resolution. Treating this as a
        # single step would silently truncate the run, so keep the old behavior.
        return _fallback_scope(cypher)
    return _scope(MODE_PATH, step_labels, edges)
