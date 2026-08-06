"""
Diagnostic test for boolean parameter coercion in the sequence executor.

Run-panel forms (and webhook callers) submit every parameter value as a string,
so a parameter declared ``value_type: "boolean"`` used to reach Neo4j as the
string ``'true'``/``'false'`` — which never equals a Cypher boolean literal in a
WHERE filter (the READ_VALUE_PILLAR_CONNECTION is_active bug). The executor must:

  - convert "true"/"1" and "false"/"0" (any case) to real booleans for
    boolean-declared parameters before binding;
  - leave non-boolean-declared parameters untouched;
  - leave unrecognized boolean text and already-boolean values untouched;
  - apply the coercion inside ``_execute_query_step`` so the values bound to
    ``graph.run_cypher_for_space`` are real booleans.

Run: ``python tests/boolean-param-coercion.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import catalog, execution, graph  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- _coerce_declared_boolean_params ------------------------------------------
DECLARED = [
    {"name": "pillarIsActive", "value_type": "boolean", "value": "", "is_required": True},
    {"name": "pillarName", "value_type": "string", "value": "", "is_required": True},
]

out = execution._coerce_declared_boolean_params(
    DECLARED,
    {"pillarIsActive": "true", "pillarName": "true", "unrelated": "false"},
)
check("boolean-declared 'true' becomes True", out["pillarIsActive"] is True)
check("string-declared parameter stays a string", out["pillarName"] == "true")
check("undeclared parameter stays a string", out["unrelated"] == "false")

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarIsActive": "FALSE"})
check("boolean-declared 'FALSE' becomes False (case-insensitive)",
      out["pillarIsActive"] is False)

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarIsActive": "1"})
check("boolean-declared '1' becomes True", out["pillarIsActive"] is True)

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarIsActive": "0"})
check("boolean-declared '0' becomes False", out["pillarIsActive"] is False)

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarIsActive": True})
check("already-boolean value passes through", out["pillarIsActive"] is True)

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarIsActive": "maybe"})
check("unrecognized boolean text passes through untouched",
      out["pillarIsActive"] == "maybe")

out = execution._coerce_declared_boolean_params(DECLARED, {"pillarName": "x"})
check("absent boolean parameter is not injected", "pillarIsActive" not in out)


# --- _execute_query_step binds coerced values ---------------------------------
REFERENCED = {
    "id": "Q_TEST",
    "name": "CREATE_PILLAR_TEST",
    "kind": "operation",
    "operation": "create",
    "cypher": ["MERGE (n:INSTANCE { attributive_label: 'PILLAR', NAME: $pillarName, "
               "IS_ACTIVE: $pillarIsActive }) RETURN *"],
    "parameters": DECLARED,
    "runtime_enabled": 1,
    "triggerable": 1,
    "suspended": 0,
}

captured: list[dict] = []


def _fake_fetch(query_id):
    return dict(REFERENCED)


def _fake_run(space_id, cypher, params):
    captured.append(dict(params))
    return {"records": [], "graph": None, "summary": {"counters": {}}}


_original_fetch = catalog.fetch_query_for_compose
_original_run = graph.run_cypher_for_space
catalog.fetch_query_for_compose = _fake_fetch  # type: ignore[assignment]
graph.run_cypher_for_space = _fake_run  # type: ignore[assignment]
try:
    execution._execute_query_step(
        "SP_TEST", "Q_TEST",
        {"pillarIsActive": "true", "pillarName": "Physical Fitness"},
    )
finally:
    catalog.fetch_query_for_compose = _original_fetch  # type: ignore[assignment]
    graph.run_cypher_for_space = _original_run  # type: ignore[assignment]

check("one statement was executed", len(captured) == 1)
bound = captured[0] if captured else {}
check("step binds a real boolean for the boolean-declared parameter",
      bound.get("pillarIsActive") is True)
check("step binds the string parameter unchanged",
      bound.get("pillarName") == "Physical Fitness")

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
