"""
Sequence loop policy: config normalization, cycle analysis, and guard evaluation.

A looping sequence is expressed in two halves that must agree, so they live here
together rather than split across the composer and the executor:

- **The graph defines the cycle.** A ``POINTS_TO`` edge that points back to an
  earlier STEP closes a loop. Authors do not mark the edge; it is found
  structurally (:func:`analyze_loop`) from the composed step graph.
- **The sequence type defines termination.** ``queries.loop_config`` names the
  rule that decides whether to traverse the back-edge again (``for`` counts,
  ``for_while`` tests a condition, ``for_each`` walks a result set). ``dag`` — the
  default and the historical behavior — never re-enters a step, so a back-edge
  simply terminates.

The composer stores the analysis on the package as ``loop``; the executor reads it
to route the back-edge versus the exit edges (see
``execution_run._advance_transitions``).
"""

from __future__ import annotations

from typing import Any

# ``dag`` is the default: steps are walked once, so a back-edge terminates rather
# than iterating. The other three re-enter the cycle under different rules.
LOOP_TYPES = ("dag", "for", "for_while", "for_each")

# Safety net for every looping run. A guard that never goes false would otherwise
# spin forever against Neo4j; the run aborts with an error instead.
DEFAULT_MAX_ITERATIONS = 1000

# Mirrors QUERY-package.schema.json ``returnItem.comparison_operator`` so a loop
# condition offers the same vocabulary as a boolean RETURN projection.
COMPARISON_OPERATORS = (
    "=",
    "<>",
    "<",
    "<=",
    ">",
    ">=",
    "CONTAINS",
    "STARTS WITH",
    "ENDS WITH",
)

_STRING_OPERATORS = ("CONTAINS", "STARTS WITH", "ENDS WITH")
_TRUTHY_TOKENS = ("true", "1", "yes")
_FALSY_TOKENS = ("false", "0", "no")


# --- config -------------------------------------------------------------------------


def _as_positive_int(value: Any) -> int | None:
    """Coerce to a non-negative int, or None when the value is not one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = int(text)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def normalize_loop_config(raw: Any) -> dict[str, Any]:
    """
    Normalize a stored ``loop_config`` into the shape the composer and executor use.

    Never raises: an unrecognized or malformed config degrades to ``dag`` so a bad
    row can't make a sequence unrunnable. Shape problems that the author must fix
    are reported separately by :func:`validate_loop_config`.
    """
    config = raw if isinstance(raw, dict) else {}
    loop_type = str(config.get("type") or "dag").strip().lower()
    if loop_type not in LOOP_TYPES:
        loop_type = "dag"

    max_iterations = _as_positive_int(config.get("max_iterations"))
    out: dict[str, Any] = {
        "type": loop_type,
        "max_iterations": max_iterations or DEFAULT_MAX_ITERATIONS,
    }
    if loop_type == "for":
        count = _as_positive_int(config.get("count"))
        out["count"] = count if count is not None else 0
    elif loop_type == "for_while":
        condition = config.get("condition")
        condition = condition if isinstance(condition, dict) else {}
        operator = str(condition.get("operator") or "=").strip().upper()
        if operator not in COMPARISON_OPERATORS:
            operator = "="
        out["condition"] = {
            "parameter": str(condition.get("parameter") or "").strip(),
            "operator": operator,
            "value": "" if condition.get("value") is None else str(condition.get("value")),
        }
    elif loop_type == "for_each":
        out["source"] = str(config.get("source") or "").strip()
    return out


def validate_loop_config(
    config: dict[str, Any],
    available: set[str],
    iterable: set[str] | None = None,
) -> list[str]:
    """
    Author-facing problems with a normalized loop config.

    ``available`` is every name a loop condition can test: the sequence's declared
    parameters, its steps' parameters, and every RETURN alias its steps project.
    ``iterable`` is the narrower set a for-each may walk — only RETURN aliases,
    since iterating needs an actual result set behind the name. Returns readable
    messages; an empty list means the config is usable.
    """
    iterable = available if iterable is None else iterable
    loop_type = config.get("type") or "dag"
    if loop_type == "dag":
        return []

    problems: list[str] = []
    if loop_type == "for":
        count = config.get("count")
        max_iterations = int(config.get("max_iterations") or DEFAULT_MAX_ITERATIONS)
        if not isinstance(count, int) or count < 0:
            problems.append("A for loop needs a whole number of iterations.")
        elif count > max_iterations:
            problems.append(
                f"A for loop of {count} iterations exceeds this sequence's maximum of "
                f"{max_iterations}. Lower the count or raise the maximum."
            )
    elif loop_type == "for_while":
        condition = config.get("condition") or {}
        parameter = str(condition.get("parameter") or "").strip()
        if not parameter:
            problems.append("A for/while loop needs a parameter to test.")
        elif parameter not in available:
            problems.append(
                f"for/while tests {parameter!r}, which is not a parameter of this sequence "
                "or a RETURN alias projected by any of its steps."
            )
        if str(condition.get("operator") or "") not in COMPARISON_OPERATORS:
            problems.append("A for/while loop needs a comparison operator.")
    elif loop_type == "for_each":
        source = str(config.get("source") or "").strip()
        if not source:
            problems.append("A for/each loop needs a RETURN alias to iterate.")
        elif source not in iterable:
            problems.append(
                f"for/each iterates {source!r}, which is not a RETURN alias projected by "
                "any of this sequence's steps."
            )
    return problems


# --- cycle analysis -----------------------------------------------------------------


def _forward_targets(steps: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for step_id, step in steps.items():
        targets: list[str] = []
        for transition in step.get("next") or []:
            target = str(transition.get("id") or "").strip()
            if target and target in steps:
                targets.append(target)
        out[step_id] = targets
    return out


def find_back_edges(
    steps: dict[str, dict[str, Any]], entry_id: str | None = None
) -> list[tuple[str, str]]:
    """
    Every edge that closes a cycle, as ``(source, target)`` pairs.

    Iterative DFS with grey/black colouring: an edge into a node still on the
    current stack (grey) points backwards, so it closes a loop. Starting at the
    entry step keeps the classification stable — with several equivalent orderings
    of a cycle, the back-edge is the one reached last from the entry.
    """
    targets = _forward_targets(steps)
    grey: set[str] = set()
    black: set[str] = set()
    back_edges: list[tuple[str, str]] = []

    roots: list[str] = []
    if entry_id and entry_id in steps:
        roots.append(entry_id)
    roots.extend(step_id for step_id in steps if step_id != entry_id)

    for root in roots:
        if root in black or root in grey:
            continue
        # (node, index of the next outgoing edge to examine)
        stack: list[list[Any]] = [[root, 0]]
        grey.add(root)
        while stack:
            node, cursor = stack[-1]
            neighbours = targets.get(node) or []
            if cursor >= len(neighbours):
                stack.pop()
                grey.discard(node)
                black.add(node)
                continue
            stack[-1][1] = cursor + 1
            target = neighbours[cursor]
            if target in grey:
                if (node, target) not in back_edges:
                    back_edges.append((node, target))
                continue
            if target in black:
                continue
            grey.add(target)
            stack.append([target, 0])
    return back_edges


def _reachable(adjacency: dict[str, list[str]], start: str) -> set[str]:
    """Nodes reachable from ``start``, including ``start`` itself."""
    seen = {start}
    queue = [start]
    while queue:
        node = queue.pop()
        for target in adjacency.get(node) or []:
            if target not in seen:
                seen.add(target)
                queue.append(target)
    return seen


def cycle_body(
    steps: dict[str, dict[str, Any]], source: str, target: str
) -> list[str]:
    """
    The steps that make up the cycle closed by the back-edge ``source -> target``.

    A step is in the body when it is both reachable from the cycle entry
    (``target``) and able to reach the back-edge source. That intersection excludes
    steps hanging off an exit edge, which are reachable from the entry but cannot
    reach the source.
    """
    forward = _forward_targets(steps)
    reverse: dict[str, list[str]] = {step_id: [] for step_id in steps}
    for step_id, targets in forward.items():
        for node in targets:
            reverse[node].append(step_id)

    descendants = _reachable(forward, target)
    ancestors = _reachable(reverse, source)
    body = descendants & ancestors
    body.add(target)
    body.add(source)
    # Preserve package order so the descriptor reads predictably.
    return [step_id for step_id in steps if step_id in body]


def analyze_loop(
    steps: dict[str, dict[str, Any]],
    loop_config: Any,
    entry_id: str | None = None,
    alias_steps: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """
    Build the package's ``loop`` descriptor, or None when the run is a plain DAG walk.

    ``alias_steps`` maps a RETURN alias to the step that projects it, which pins a
    for-each loop's row source to a specific step id. Naming the step matters
    because an empty result set has no row to recognize the alias in — without it
    the executor could not tell "the source returned nothing" (skip the body) from
    "this step is not the source" (keep looking).

    Raises ValueError when a loop type is selected but the graph can't support it —
    no cycle to iterate, or more than one. ``dag`` sequences are never rejected: a
    back-edge there keeps its historical meaning (visited steps are not re-entered),
    so existing sequences are unaffected.
    """
    config = normalize_loop_config(loop_config)
    if config["type"] == "dag":
        return None

    back_edges = find_back_edges(steps, entry_id)
    if not back_edges:
        raise ValueError(
            f"This sequence is set to loop ({config['type']}) but its steps contain no "
            "cycle. Add a transition from a later step back to an earlier one to close "
            "the loop."
        )
    if len(back_edges) > 1:
        raise ValueError(
            f"This sequence is set to loop ({config['type']}) but its steps contain "
            f"{len(back_edges)} cycles. A looping sequence must contain exactly one."
        )

    source, target = back_edges[0]
    descriptor = {
        **config,
        "back_edge": {"from": source, "to": target},
        "body": cycle_body(steps, source, target),
    }
    if config["type"] == "for_each":
        descriptor["source_step"] = (alias_steps or {}).get(config.get("source") or "", "")
    return descriptor


# --- guard evaluation ---------------------------------------------------------------


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in _TRUTHY_TOKENS:
        return True
    if text in _FALSY_TOKENS:
        return False
    return None


def compare(left: Any, operator: str, right: Any) -> bool:
    """
    Evaluate one loop comparison.

    Typing follows the operands rather than a declared schema, since run state is
    whatever the steps bound: a boolean on the left compares as a boolean, two
    numeric-looking operands compare numerically, and anything else compares as
    text. An unresolved (None) left side compares as the empty string, so a missing
    parameter reads as false and the loop stops rather than spinning.
    """
    op = (operator or "=").strip().upper()

    if op in _STRING_OPERATORS:
        haystack = "" if left is None else str(left)
        needle = "" if right is None else str(right)
        if op == "CONTAINS":
            return needle in haystack
        if op == "STARTS WITH":
            return haystack.startswith(needle)
        return haystack.endswith(needle)

    if isinstance(left, bool):
        right_bool = _as_bool(right)
        if right_bool is not None:
            if op == "=":
                return left is right_bool
            if op == "<>":
                return left is not right_bool
            # Ordering against a boolean falls through to 0/1 numerics.
            return _compare_numbers(float(left), op, float(right_bool))

    left_number = _as_number(left)
    right_number = _as_number(right)
    if left_number is not None and right_number is not None:
        return _compare_numbers(left_number, op, right_number)

    left_text = "" if left is None else str(left)
    right_text = "" if right is None else str(right)
    if op == "=":
        return left_text == right_text
    if op == "<>":
        return left_text != right_text
    return _compare_ordered_text(left_text, op, right_text)


def _compare_numbers(left: float, operator: str, right: float) -> bool:
    if operator == "=":
        return left == right
    if operator == "<>":
        return left != right
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    return False


def _compare_ordered_text(left: str, operator: str, right: str) -> bool:
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">":
        return left > right
    if operator == ">=":
        return left >= right
    return False


def condition_holds(condition: Any, resolved: dict[str, Any]) -> bool:
    """True when a ``for_while`` condition still holds against current run state."""
    spec = condition if isinstance(condition, dict) else {}
    parameter = str(spec.get("parameter") or "").strip()
    if not parameter:
        return False
    return compare(
        resolved.get(parameter), str(spec.get("operator") or "="), spec.get("value")
    )
