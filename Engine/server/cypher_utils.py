"""
Shared helpers for scanning and building Cypher statement strings.

Several modules (schema_delete, schema_update, spaces, execution, templates,
graph, schema_currency) previously kept private copies of these regexes and
helpers, with comments noting they "mirror" each other. They live here once so
the definitions cannot drift.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Matches an ``attributive_label: 'X'`` / ``attributive_label:"X"`` map binding, or the
# equality form ``attributive_label = 'X'`` used by vector-search WHERE filters.
# Used for precise (exact-label) reference detection rather than naive substring
# matching, which would catch labels embedded in other labels or string literals.
ATTR_LABEL_RE = re.compile(
    r"attributive_label\s*(?::|=)\s*['\"]([^'\"]+)['\"]"
)

# Mirrors App/authoring ``normalizeAttributiveLabel``: display titles and UPPER_SNAKE
# forms of the same name must compare equal ("Call Discord …" ↔ CALL_DISCORD_…).
_ATTRIBUTIVE_LABEL_PARAM_RE = re.compile(r"^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$")


def normalize_attributive_label(value: str | None) -> str:
    """UPPER_SNAKE form of an attributive_label; ``$param`` references stay verbatim."""
    text = "" if value is None else str(value)
    trimmed = text.strip()
    if _ATTRIBUTIVE_LABEL_PARAM_RE.fullmatch(trimmed):
        return trimmed
    return re.sub(r"[^A-Z0-9_]", "", re.sub(r"\s+", "_", text).upper())


def attributive_labels_equivalent(left: str | None, right: str | None) -> bool:
    """True when two labels are the same string or normalize to the same UPPER_SNAKE name."""
    a = (left or "").strip()
    b = (right or "").strip()
    if not a or not b:
        return False
    return a == b or normalize_attributive_label(a) == normalize_attributive_label(b)


# A relationship pattern (``-[...]->``) in a sequence read query means the sequence
# walks past its initial STEP. Without one, the query matches only the initial node,
# so the sequence is scoped to that single step even though the shared STEP node may
# point to others in the graph.
STEP_TRAVERSAL_RE = re.compile(r"-\s*\[")

# A *variable-length* hop (``-[*]->``, ``-[r*1..3]->``) is the only pattern that asks
# for an unbounded walk. Named hops enumerate the edges they traverse, so they are
# scoped to those (see sequence_scope). Kept distinct from STEP_TRAVERSAL_RE because
# conflating the two is what made every multi-hop sequence expand into the whole graph.
STEP_OPEN_TRAVERSAL_RE = re.compile(r"-\s*\[[^\]]*\*")

# Credential reference token: ``$secret.<NAME>``. The dot makes it distinct from a
# normal ``$param`` (param names never contain dots), so it is not auto-discovered as
# a workflow parameter and is resolved separately from the per-space credential store
# at run time.
SECRET_REF_RE = re.compile(r"\$secret\.([A-Za-z_][A-Za-z0-9_]*)")

# --- RETURN column naming (see return_aliases) ---------------------------------------
# A statement can hold several RETURN clauses (UNION), and each is bounded by the
# clause keywords that may legally follow it.
_RETURN_HEAD_RE = re.compile(r"\bRETURN\b(?:\s+DISTINCT\b)?", re.IGNORECASE)
_RETURN_TAIL_RE = re.compile(r"\b(?:ORDER\s+BY|SKIP|LIMIT|UNION)\b", re.IGNORECASE)
# ``AS name`` — only identifier-shaped aliases, since a backtick-quoted one could never
# be referenced as ``$name`` by a downstream step.
_AS_ALIAS_RE = re.compile(r"\bAS\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
_BARE_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Quoted literals are blanked before scanning so an ``AS`` (or comma) inside a string
# cannot be mistaken for syntax.
_QUOTED_LITERAL_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"")


def labels_in_cypher_array(raw_cypher: str | None) -> set[str]:
    """All ``attributive_label`` values bound across a query's ``cypher`` JSON array."""
    if not raw_cypher:
        return set()
    try:
        statements = json.loads(raw_cypher)
    except (ValueError, TypeError):
        return set()
    if not isinstance(statements, list):
        return set()
    labels: set[str] = set()
    for stmt in statements:
        for match in ATTR_LABEL_RE.finditer(str(stmt or "")):
            label = match.group(1).strip()
            if label:
                labels.add(label)
    return labels


def cypher_has_step_hop(cypher: Any) -> bool:
    """
    True when a sequence's read query walks beyond its initial STEP node.

    ``MATCH (n:STEP {attributive_label:'X'}) RETURN *`` scopes the sequence to just that
    step, whereas any relationship pattern carries it onward. STEP nodes (and their
    POINTS_TO edges) are shared across sequences, so a one-step sequence that shares its
    node with a longer sequence must not inherit that chain.

    This answers "is this sequence multi-step?", which is what the catalog's
    ``single_step`` flag, delete partitioning, and wrap retargeting need. It does *not*
    say how far the walk reaches — see :func:`cypher_walks_open_downstream`.
    """
    if not isinstance(cypher, list):
        return False
    return any(STEP_TRAVERSAL_RE.search(str(stmt or "")) for stmt in cypher)


def cypher_walks_open_downstream(cypher: Any) -> bool:
    """
    True when a sequence's read query asks for an unbounded downstream walk.

    Only a variable-length hop qualifies: ``(:STEP {attributive_label:'X'})-[*]->(d)``,
    which the builder emits for the "Return downstream" toggle. A query that names its
    hops (``-[:POINTS_TO {attributive_label:'SEND_TO_DISCORD'}]->``) enumerates the
    edges it traverses, so it is scoped to exactly those.

    Used as the fallback for rows with no ``builder_config`` snapshot to read.
    """
    if not isinstance(cypher, list):
        return False
    return any(STEP_OPEN_TRAVERSAL_RE.search(str(stmt or "")) for stmt in cypher)


def _blank_quoted_literals(text: str) -> str:
    """Replace quoted literals with same-length blanks, preserving offsets."""
    return _QUOTED_LITERAL_RE.sub(lambda m: " " * len(m.group(0)), text)


def _split_top_level(segment: str) -> list[str]:
    """Split a RETURN body on commas that are not nested in brackets."""
    parts: list[str] = []
    depth = 0
    start = 0
    for index, char in enumerate(segment):
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(segment[start:index])
            start = index + 1
    parts.append(segment[start:])
    return parts


def return_aliases(cypher: Any) -> list[str]:
    """
    Identifier-shaped column names a query's RETURN clauses project, in order.

    These are the names a step can publish into run state: the executor binds a query
    step's scalar RETURN columns under their alias (see
    ``execution_run._bind_query_return_columns``), so this is what an author may
    reference from a loop condition or a for-each source.

    Only aliased projections (``count(x) AS total``) and bare identifier projections
    (``RETURN n``) are reported — an unaliased expression comes back keyed by its raw
    text ("r.id IS NOT NULL"), which no downstream step could name. ``RETURN *``
    contributes nothing, since its columns are only knowable at run time.
    """
    if isinstance(cypher, str):
        statements: list[Any] = [cypher]
    elif isinstance(cypher, list):
        statements = list(cypher)
    else:
        return []

    aliases: list[str] = []
    seen: set[str] = set()
    for stmt in statements:
        text = _blank_quoted_literals(str(stmt or ""))
        for head in _RETURN_HEAD_RE.finditer(text):
            body_start = head.end()
            tail = _RETURN_TAIL_RE.search(text, body_start)
            body = text[body_start : tail.start() if tail else len(text)]
            for projection in _split_top_level(body):
                trimmed = projection.strip()
                if not trimmed or trimmed == "*":
                    continue
                # The last alias wins: `substring(a AS x) AS y` names the column y.
                alias_matches = _AS_ALIAS_RE.findall(trimmed)
                name = (
                    alias_matches[-1]
                    if alias_matches
                    else (trimmed if _BARE_IDENTIFIER_RE.match(trimmed) else "")
                )
                if name and name not in seen:
                    seen.add(name)
                    aliases.append(name)
    return aliases


def escape_identifier(name: str) -> str:
    """Escape a property key for use inside a Cypher backtick identifier."""
    return name.replace("`", "``")
