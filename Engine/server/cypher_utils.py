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

# Mirrors App/authoring ``normalizeAttributiveLabel``: display titles and stored
# forms of the same name must compare equal ("Call Discord …" ↔ call_discord_…).
_ATTRIBUTIVE_LABEL_PARAM_RE = re.compile(r"^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$")


def normalize_attributive_label(value: str | None) -> str:
    """lowercase_snake form of an attributive_label; ``$param`` references stay verbatim."""
    text = "" if value is None else str(value)
    trimmed = text.strip()
    if _ATTRIBUTIVE_LABEL_PARAM_RE.fullmatch(trimmed):
        return trimmed
    return re.sub(r"[^a-z0-9_]", "", re.sub(r"\s+", "_", text).lower())


def attributive_labels_equivalent(left: str | None, right: str | None) -> bool:
    """True when two labels are the same string or normalize to the same snake name."""
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


# A visual-builder query is one MATCH / CREATE / MERGE statement. These clause
# words start a second pipeline or a procedure call, which the builder cannot reopen.
_BUILDER_BLOCKING = ("LOAD CSV", "FOREACH", "UNION", "CALL", "WITH", "REMOVE", "YIELD", "USE")
_BUILDER_LABELS = {"INSTANCE", "SCHEMA", "STEP"}
_BUILDER_SHAPE = (
    "Write one statement the visual builder can open: "
    "MATCH (var:INSTANCE { attributive_label: 'name' }) "
    "then optional WHERE, then RETURN, SET, or DELETE. "
    "CREATE or MERGE for a new node. "
    "Hops are directed, -[r:TYPE]-> or <-[r:TYPE]-. "
    "Do not use WITH, UNION, CALL, or a custom label such as :Person."
)


def builder_query_problem(cypher: Any, *, kind: str = "operation") -> str | None:
    """Why this Cypher cannot be reopened in the visual builder, or None when it can.

    Chat-agent operations are edited in that builder, so a proposal is rejected
    unless its statement is one the builder can show. Mirrors the shapes
    ``synthesizeBuilderConfig`` accepts.
    """
    statements = _builder_statements(cypher)
    if not statements:
        return "Cypher is required. " + _BUILDER_SHAPE
    if len(statements) != 1:
        return "The visual builder opens one statement. " + _BUILDER_SHAPE
    text = statements[0]
    try:
        blocked = _builder_blocked(text)
        if blocked:
            return f"{blocked} is not available in the visual builder. " + _BUILDER_SHAPE
        if not _builder_starts(text):
            return "Start with MATCH, CREATE, or MERGE. " + _BUILDER_SHAPE
        labels = _builder_pattern_labels(text)
        undirected = _builder_undirected(text)
        if undirected:
            return "Relationship hops must be directed: -[r:TYPE]-> or <-[r:TYPE]-."
        bad_map = _builder_maps(text)
        if bad_map:
            return bad_map
        clash = _builder_clause_clash(text)
        if clash:
            return clash
    except ValueError:
        return "This statement is not a pattern the visual builder can open. " + _BUILDER_SHAPE
    foreign = next((label for label in labels if label.upper() not in _BUILDER_LABELS), None)
    if foreign:
        return (
            f"Match :INSTANCE, :SCHEMA, or :STEP and put the name in attributive_label. "
            f":{foreign} is not a builder label — write "
            f"(p:INSTANCE {{ attributive_label: '{foreign}' }})."
        )
    if (kind or "").strip().lower() == "sequence" and not any(label.upper() == "STEP" for label in labels):
        return "A sequence matches a STEP: MATCH (step:STEP { attributive_label: 'NAME' }) RETURN *."
    return None


def _builder_statements(cypher: Any) -> list[str]:
    if isinstance(cypher, str):
        pieces: list[Any] = [cypher]
    elif isinstance(cypher, list):
        pieces = list(cypher)
    else:
        return []
    statements: list[str] = []
    for piece in pieces:
        for statement in _split_statements(_strip_cypher_comments(str(piece or ""))):
            if statement and not re.match(r"CREATE\s+INDEX\b", statement, re.IGNORECASE):
                statements.append(statement)
    return statements


def _strip_cypher_comments(src: str) -> str:
    out: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(src):
        ch = src[i]
        if quote:
            out.append(ch)
            if ch == "\\":
                if i + 1 < len(src):
                    out.append(src[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(src) and src[i + 1] == "/":
            while i < len(src) and src[i] != "\n":
                i += 1
            out.append(" ")
            continue
        if ch == "/" and i + 1 < len(src) and src[i + 1] == "*":
            i += 2
            while i < len(src) and not (src[i] == "*" and i + 1 < len(src) and src[i + 1] == "/"):
                i += 1
            i = min(i + 2, len(src))
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _split_statements(src: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(src):
        ch = src[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == ";" and depth == 0:
            parts.append(src[start:i])
            start = i + 1
        i += 1
    parts.append(src[start:])
    return [part.strip() for part in parts if part.strip()]


def _builder_starts(text: str) -> bool:
    stripped = text.lstrip()
    for phrase in ("OPTIONAL MATCH", "MATCH", "CREATE", "MERGE"):
        end = _keyword_end(stripped, 0, phrase)
        if end >= 0:
            return True
    return False


def _builder_blocked(text: str) -> str | None:
    return _keyword_at_depth0(text, _BUILDER_BLOCKING)


def _builder_clause_clash(text: str) -> str | None:
    found: set[str] = set()
    depth = 0
    quote: str | None = None
    phrases = ("OPTIONAL MATCH", "DETACH DELETE", "MATCH", "CREATE", "MERGE", "SET", "DELETE", "RETURN")
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
            i += 1
            continue
        if ch in ")]}":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0:
            matched = False
            for phrase in phrases:
                end = _keyword_end(text, i, phrase)
                if end >= 0:
                    found.add(phrase)
                    i = end
                    matched = True
                    break
            if matched:
                continue
        i += 1
    if "CREATE" in found and ("MATCH" in found or "OPTIONAL MATCH" in found):
        return "Use CREATE or MERGE on its own. The visual builder does not open CREATE together with MATCH."
    if ("DELETE" in found or "DETACH DELETE" in found) and "SET" in found:
        return "Use SET for an update or DELETE for a delete, not both in one statement."
    if ("DELETE" in found or "DETACH DELETE" in found) and "RETURN" in found:
        return "A delete query has no RETURN."
    return None


def _keyword_at_depth0(text: str, phrases: tuple[str, ...]) -> str | None:
    depth = 0
    quote: str | None = None
    i = 0
    ordered = tuple(sorted(phrases, key=len, reverse=True))
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
            i += 1
            continue
        if ch in ")]}":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0:
            for phrase in ordered:
                end = _keyword_end(text, i, phrase)
                if end >= 0:
                    return phrase
        i += 1
    return None


def _keyword_end(src: str, i: int, phrase: str) -> int:
    if i > 0 and (src[i - 1].isalnum() or src[i - 1] == "_"):
        return -1
    words = phrase.split()
    j = i
    for index, word in enumerate(words):
        if src[j : j + len(word)].upper() != word.upper():
            return -1
        j += len(word)
        if index < len(words) - 1:
            if j >= len(src) or not src[j].isspace():
                return -1
            while j < len(src) and src[j].isspace():
                j += 1
    if j < len(src) and (src[j].isalnum() or src[j] == "_"):
        return -1
    return j


def _builder_pattern_labels(text: str) -> list[str]:
    labels: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "'\"`":
            i = _skip_string(text, i)
            continue
        rel = _rel_at(text, i) if ch in "-<" else None
        if rel is not None:
            i = rel[0]
            continue
        if ch == "[":
            i = _closer(text, i, "[", "]") + 1
            continue
        if ch == "(":
            end = _closer(text, i, "(", ")")
            inner = text[i + 1 : end]
            head = _before_map(inner)
            labels.extend(_colon_labels(head))
            i = end + 1
            continue
        i += 1
    return labels


def _builder_undirected(text: str) -> bool:
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "'\"`":
            i = _skip_string(text, i)
            continue
        if ch in "-<":
            rel = _rel_at(text, i)
            if rel is not None:
                _end, directed = rel
                if not directed:
                    return True
                i = _end
                continue
        i += 1
    return False


def _builder_maps(text: str) -> str | None:
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "'\"`":
            i = _skip_string(text, i)
            continue
        if ch == "{":
            end = _closer(text, i, "{", "}")
            problem = _literal_map(text[i : end + 1])
            if problem:
                return problem
            i = end + 1
            continue
        i += 1
    return None


def _literal_map(body: str) -> str | None:
    inner = body.strip()[1:-1].strip()
    if not inner:
        return None
    for part in _split_commas(inner):
        colon = _top_colon(part)
        if colon < 0:
            return "The visual builder cannot open a subquery. " + _BUILDER_SHAPE
        if not _is_literal(part[colon + 1 :].strip()):
            return (
                "A pattern property must be a string, number, true, false, null, or a $parameter. "
                + _BUILDER_SHAPE
            )
    return None


def _is_literal(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    if text[0] in "'\"":
        try:
            end = _skip_string(text, 0)
        except ValueError:
            return False
        return text[end:].strip() == ""
    if re.fullmatch(r"\$[A-Za-z_][A-Za-z0-9_]*", text):
        return True
    if re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        return True
    return text.lower() in ("true", "false", "null")


def _rel_at(text: str, i: int) -> tuple[int, bool] | None:
    """A relationship starting at i, as (end index, directed). None when this is not a hop."""
    if i >= len(text) or text[i] not in "-<":
        return None
    incoming = False
    j = i
    if text[j] == "<":
        if j + 1 >= len(text) or text[j + 1] != "-":
            return None
        incoming = True
        j += 1
    if j >= len(text) or text[j] != "-":
        return None
    while j < len(text) and text[j] == "-":
        j += 1
    saw_bracket = False
    if j < len(text) and text[j] == "[":
        saw_bracket = True
        j = _closer(text, j, "[", "]") + 1
        while j < len(text) and text[j] == "-":
            j += 1
    outgoing = j < len(text) and text[j] == ">"
    if outgoing:
        j += 1
    dashes = text[i:j].count("-")
    if not incoming and not outgoing and not saw_bracket and dashes < 2:
        return None
    return j, incoming != outgoing


def _before_map(inner: str) -> str:
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch == "{" and depth == 0:
            return inner[:i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        i += 1
    return inner


def _split_commas(src: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(src):
        ch = src[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            parts.append(src[start:i])
            start = i + 1
        i += 1
    parts.append(src[start:])
    return parts


def _colon_labels(head: str) -> list[str]:
    labels: list[str] = []
    for match in re.finditer(r":\s*(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))", head):
        label = (match.group(1) or match.group(2) or "").strip()
        if label:
            labels.append(label)
    return labels


def _top_colon(src: str) -> int:
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(src):
        ch = src[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == ":" and depth == 0:
            return i
        i += 1
    return -1


def _skip_string(text: str, i: int) -> int:
    quote = text[i]
    i += 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            return i + 1
        i += 1
    raise ValueError("unclosed string")


def _closer(text: str, i: int, open_ch: str, close_ch: str) -> int:
    depth = 0
    while i < len(text):
        ch = text[i]
        if ch in "'\"`":
            i = _skip_string(text, i)
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unclosed")
