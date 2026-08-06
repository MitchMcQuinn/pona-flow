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

# Matches an ``attributive_label: 'X'`` / ``attributive_label:"X"`` binding inside a
# Cypher (or SQLite) statement. Used for precise (exact-label) reference detection
# rather than naive substring matching, which would catch labels embedded in other
# labels or string literals.
ATTR_LABEL_RE = re.compile(r"attributive_label\s*:\s*['\"]([^'\"]+)['\"]")

# A relationship pattern (``-[...]->``) in a sequence read query means the sequence
# walks past its initial STEP into the downstream POINTS_TO chain. Without one, the
# query matches only the initial node, so the sequence is scoped to that single step
# even though the shared STEP node may point to others in the graph.
STEP_TRAVERSAL_RE = re.compile(r"-\s*\[")

# Credential reference token: ``$secret.<NAME>``. The dot makes it distinct from a
# normal ``$param`` (param names never contain dots), so it is not auto-discovered as
# a workflow parameter and is resolved separately from the per-space credential store
# at run time.
SECRET_REF_RE = re.compile(r"\$secret\.([A-Za-z_][A-Za-z0-9_]*)")


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


def cypher_traverses_downstream(cypher: Any) -> bool:
    """
    True when a sequence's read query walks beyond its initial STEP node.

    ``MATCH (n:STEP {attributive_label:'X'}) RETURN *`` scopes the sequence to just that
    step, whereas ``MATCH (:STEP {attributive_label:'X'})-[*]->(d) RETURN path`` pulls in
    the downstream chain. STEP nodes (and their POINTS_TO edges) are shared across
    sequences, so a one-step sequence that shares its node with a longer sequence must
    not inherit that chain.
    """
    if not isinstance(cypher, list):
        return False
    return any(STEP_TRAVERSAL_RE.search(str(stmt or "")) for stmt in cypher)


def escape_identifier(name: str) -> str:
    """Escape a property key for use inside a Cypher backtick identifier."""
    return name.replace("`", "``")
