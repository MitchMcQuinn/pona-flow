"""
Diagnostic test for ``execution.compose_execution_package`` sequence scoping.

STEP nodes (and their POINTS_TO edges) are shared across sequences. A sequence's read query
encodes its scope: a single-node match (``MATCH (n:STEP {attributive_label:'X'}) RETURN *``)
covers only that step, while a traversal (``(:STEP {...})-[*]->(d) RETURN path``) pulls in the
downstream chain. This test confirms compose respects that, so a one-step sequence that shares
its initial node with a longer sequence does NOT inherit the longer sequence's steps or their
response parameters.

No Neo4j or SQLite needed — the entity/adjacency loaders and catalog lookup are stubbed.

Run: ``python tests/sequence-compose-scope.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# execution_compose is patched (not the execution facade) because the composer
# resolves its loaders against its defining module's globals.
from Engine.server import catalog, execution, execution_compose  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# Shared graph: WRITE_A_LIMERICK -> TITLE_IT. The title step carries the "title" response param.
ENTITIES = {
    "w": {
        "attributive_label": "WRITE_A_LIMERICK",
        "payload": {"endpoint": "http://example.test/write", "response_parameters": []},
        "parameters": [],
    },
    "t": {
        "attributive_label": "TITLE_IT",
        "payload": {
            "endpoint": "http://example.test/title",
            "response_parameters": [{"property_path": "title", "parameter": "title"}],
        },
        "parameters": [],
    },
}
ADJACENCY = {"w": [{"target": "t", "condition": "", "condition_type": ""}]}

SEQUENCES = {
    "SEQ_TITLED": {
        "cypher": [
            "MATCH path = (:STEP { attributive_label: 'WRITE_A_LIMERICK' })-[*]->(downstream) RETURN path"
        ],
        "kind": "sequence",
        "runtime_enabled": 1,
        "triggerable": 1,
    },
    "SEQ_UNTITLED": {
        "cypher": ["MATCH (n:STEP { attributive_label: 'WRITE_A_LIMERICK' }) RETURN *"],
        "kind": "sequence",
        "runtime_enabled": 1,
        "triggerable": 1,
    },
}


def _response_param_names(package: dict) -> set[str]:
    return {rp.get("parameter") for rp in package.get("response_parameters") or []}


_orig_entities = execution_compose._load_step_entities
_orig_adjacency = execution_compose._load_step_adjacency
_orig_fetch = catalog.fetch_query_for_compose

execution_compose._load_step_entities = lambda space_id: ENTITIES  # type: ignore[assignment]
execution_compose._load_step_adjacency = lambda space_id, entities=None: ADJACENCY  # type: ignore[assignment]
catalog.fetch_query_for_compose = lambda qid: SEQUENCES.get((qid or "").strip())  # type: ignore[assignment]

try:
    titled = execution.compose_execution_package("SP", "SEQ_TITLED")
    untitled = execution.compose_execution_package("SP", "SEQ_UNTITLED")

    titled_ids = {step["id"] for step in titled.get("steps") or []}
    untitled_ids = {step["id"] for step in untitled.get("steps") or []}

    # Traversal sequence keeps the whole chain and its response parameter.
    check("titled sequence includes both steps", titled_ids == {"w", "t"})
    check("titled sequence exposes the 'title' response param", "title" in _response_param_names(titled))

    # Single-node sequence is scoped to just its initial step.
    check("untitled sequence includes only the write step", untitled_ids == {"w"})
    check("untitled sequence does NOT expose 'title'", "title" not in _response_param_names(untitled))

    # The write step's transition to title must be dropped for the single-node sequence so the
    # executor can't advance into a step that isn't part of the package.
    untitled_write = next((s for s in untitled.get("steps") or [] if s["id"] == "w"), None)
    check("untitled write step has no dangling transition", bool(untitled_write) and not untitled_write["next"])

    titled_write = next((s for s in titled.get("steps") or [] if s["id"] == "w"), None)
    check(
        "titled write step keeps its transition to title",
        bool(titled_write) and any(tr.get("id") == "t" for tr in titled_write["next"]),
    )
finally:
    execution_compose._load_step_entities = _orig_entities  # type: ignore[assignment]
    execution_compose._load_step_adjacency = _orig_adjacency  # type: ignore[assignment]
    catalog.fetch_query_for_compose = _orig_fetch  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
