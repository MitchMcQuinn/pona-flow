"""
Operation STEP evaluation and parameter writes.

An operation step reads the current run's parameter map, computes one boolean
from a two-level group of comparisons, and writes that boolean plus any matching
assignment literals back into the same map. It does not query the graph and it
does not read credentials.

Missing ``$`` references compare as empty: the statement is false, except
``IS EMPTY``, which is true. A missing name, a missing group, or a bad
assignment fails the run instead of writing false.

Collision policy applies to the evaluation name and then to each matching
assignment, in that order:

- overwrite: set the key
- skip: set the key only when it is absent
- append: concatenate two strings; push onto a list; otherwise wrap and push
- sequence: set the key when absent, otherwise ``key_2``, ``key_3``, ...
"""

from __future__ import annotations

import re
from typing import Any

from . import execution_loop

_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRET_RE = re.compile(r"^\$secret(?:\.|$)", re.IGNORECASE)
_JUNCTIONS = ("AND", "OR")
_COLLISIONS = ("overwrite", "skip", "append", "sequence")
_WHENS = ("true", "false", "always")
_COMPARE_OPS = {"=", "<>", "<", "<=", ">", ">=", "CONTAINS", "STARTS WITH", "ENDS WITH"}
_UNARY_OPS = {"EXISTS", "IS EMPTY"}
_OPERATORS = _COMPARE_OPS | _UNARY_OPS | {"REGEX"}


def _parameter_name(raw: Any, label: str) -> str:
    name = str(raw or "").strip()
    if not _NAME_RE.match(name):
        raise ValueError(
            f"{label} must be a parameter name (letter or underscore, then letters, digits, or underscores)."
        )
    return name


def _junction(raw: Any, label: str) -> str:
    text = str(raw or "").strip().upper()
    if text not in _JUNCTIONS:
        raise ValueError(f"{label} must be AND or OR.")
    return text


def _collision(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if text not in _COLLISIONS:
        raise ValueError("Collision must be overwrite, skip, append, or sequence.")
    return text


def _operator(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    if text not in _OPERATORS:
        raise ValueError(f"Unknown operation operator {raw!r}.")
    return text


def resolve_operand(raw: Any, resolved: dict[str, Any]) -> tuple[Any, bool]:
    """Return ``(value, missing)`` for a literal or a ``$`` reference.

    A leading ``$`` is always a reference. ``$name`` reads that key. ``$a.b``
    reads ``resolved['a']['b']`` when the flat key ``a.b`` is not present.
    ``$secret.*`` raises so a credential never enters the comparison.
    """
    if not isinstance(raw, str):
        return raw, False
    text = raw.strip()
    if not text.startswith("$"):
        return raw, False
    if _SECRET_RE.match(text):
        raise ValueError("Operation steps cannot read credentials.")
    name = text[1:]
    if name in resolved:
        return resolved[name], False
    parts = name.split(".")
    if not parts or any(not _NAME_RE.match(part) for part in parts):
        return None, True
    if parts[0] not in resolved:
        return None, True
    current = resolved[parts[0]]
    for part in parts[1:]:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None, True
    return current, False


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value == ""
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def statement_holds(statement: dict[str, Any], resolved: dict[str, Any]) -> bool:
    """True when one comparison holds. A missing reference is false, except IS EMPTY."""
    if not isinstance(statement, dict):
        raise ValueError("Operation statement must be an object.")
    if "x" not in statement:
        raise ValueError("Operation statement needs an X value.")
    operator = _operator(statement.get("operator"))
    left, left_missing = resolve_operand(statement.get("x"), resolved)
    if operator == "EXISTS":
        return not left_missing and left is not None
    if operator == "IS EMPTY":
        return left_missing or _is_empty(left)
    if "y" not in statement:
        raise ValueError("Operation statement needs a Y value.")
    right, right_missing = resolve_operand(statement.get("y"), resolved)
    if left_missing or right_missing:
        return False
    if operator == "REGEX":
        try:
            pattern = "" if right is None else str(right)
            haystack = "" if left is None else str(left)
            return re.search(pattern, haystack) is not None
        except re.error:
            return False
    return execution_loop.compare(left, operator, right)


def _group_holds(group: dict[str, Any], resolved: dict[str, Any]) -> bool:
    if not isinstance(group, dict):
        raise ValueError("Operation group must be an object.")
    junction = _junction(group.get("statement_junction"), "Statement junction")
    statements = group.get("statements")
    if not isinstance(statements, list) or not statements:
        raise ValueError("Operation group needs at least one statement.")
    results = [statement_holds(item, resolved) for item in statements]
    if junction == "OR":
        return any(results)
    return all(results)


def evaluate(evaluation: dict[str, Any], resolved: dict[str, Any]) -> bool:
    """The evaluation's boolean. Raises ``ValueError`` when the spec is unusable."""
    if not isinstance(evaluation, dict):
        raise ValueError("Operation step is missing its evaluation.")
    _parameter_name(evaluation.get("name"), "Evaluation name")
    _collision(evaluation.get("collision"))
    junction = _junction(evaluation.get("group_junction"), "Group junction")
    groups = evaluation.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("Operation step needs at least one group.")
    results = [_group_holds(group, resolved) for group in groups]
    if junction == "OR":
        return any(results)
    return all(results)


def _assignment_value(item: dict[str, Any]) -> Any:
    kind = str(item.get("type") or "").strip().lower()
    value = item.get("value")
    if isinstance(value, str) and value.strip().startswith("$"):
        raise ValueError("Assignment values are literals, not $parameters.")
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ValueError("Boolean assignments need a true or false value.")
        return value
    if kind == "string":
        if not isinstance(value, str):
            raise ValueError("String assignments need a text value.")
        return value
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Number assignments need a finite number.")
        return value
    raise ValueError("Assignment type must be boolean, string, or number.")


def write_collision(resolved: dict[str, Any], key: str, value: Any, mode: str) -> None:
    """Apply one collision policy. ``mode`` is one of the four known policies."""
    if key not in resolved or mode == "overwrite":
        resolved[key] = value
        return
    if mode == "skip":
        return
    if mode == "append":
        current = resolved[key]
        if isinstance(current, str) and isinstance(value, str):
            resolved[key] = current + value
        elif isinstance(current, list):
            resolved[key] = [*current, value]
        else:
            resolved[key] = [current, value]
        return
    if mode == "sequence":
        suffix = 2
        while f"{key}_{suffix}" in resolved:
            suffix += 1
        resolved[f"{key}_{suffix}"] = value
        return
    raise ValueError(f"Unknown collision mode {mode!r}.")


def apply(step: dict[str, Any], resolved: dict[str, Any]) -> bool:
    """Write the evaluation boolean, then each matching assignment. Returns the boolean."""
    evaluation = step.get("evaluation")
    result = evaluate(evaluation if isinstance(evaluation, dict) else {}, resolved)
    mode = _collision((evaluation or {}).get("collision"))
    name = _parameter_name((evaluation or {}).get("name"), "Evaluation name")
    write_collision(resolved, name, result, mode)
    assignments = step.get("assignments") or []
    if not isinstance(assignments, list):
        raise ValueError("Operation assignments must be a list.")
    for item in assignments:
        if not isinstance(item, dict):
            raise ValueError("Operation assignment must be an object.")
        when = str(item.get("when") or "").strip().lower()
        if when not in _WHENS:
            raise ValueError("Assignment If Eval must be true, false, or always.")
        if when != "always" and when != ("true" if result else "false"):
            continue
        key = _parameter_name(item.get("key"), "Assignment key")
        item_mode = _collision(item.get("collision")) if item.get("collision") else mode
        write_collision(resolved, key, _assignment_value(item), item_mode)
    return result
