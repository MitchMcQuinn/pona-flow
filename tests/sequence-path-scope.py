"""
Diagnostic test for sequence path scoping.

A sequence's saved MATCH path defines the walk it runs, not just where that walk
starts. STEP nodes and their POINTS_TO edges are shared across sequences, so a
sequence that drew two hops must get exactly those two hops — otherwise it inherits
edges belonging to somebody else, and two cycles through one shared STEP collide in
a single package.

  - ``sequence_scope.resolve_sequence_scope``: the three modes it reports from a
    ``builder_config`` snapshot (single / path / open), alias-reference resolution
    for a self-loop, unnamed and ``$parameter`` relationships, incoming direction,
    branch patterns, and the legacy fallback for rows with no snapshot.
  - ``execution_compose.compose_execution_package`` end to end: a path-scoped
    sequence ignores an undeclared edge hanging off one of its steps, a named hop
    does not match a sibling edge between the same pair, and two sequences owning
    different cycles through one shared STEP both compose.

The STEP graph normally comes from SQLite plus Neo4j, so both loaders are stubbed and
the catalog is answered from a dict — nothing here touches a real space.

Run: ``python tests/sequence-path-scope.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    execution,
    execution_compose,
    sequence_scope,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


# --- snapshot builders ------------------------------------------------------
# Mirrors what the visual builder persists under builder_config.query (see
# App/composer/src/types.ts): a linear path of node / relationship elements, where a
# node closing a cycle is a reference to the alias that defined it.


def define_node(variable: str, label: str) -> dict:
    return {
        "kind": "node",
        "node": {
            "variable": variable,
            "alias_mode": "define",
            "attributive_label": label,
            "properties": [],
        },
    }


def reference_node(variable: str, label: str = "") -> dict:
    return {
        "kind": "node",
        "node": {
            "variable": variable,
            "alias_mode": "reference",
            "alias_ref": variable,
            "alias_locked": True,
            "attributive_label": label,
            "properties": [],
        },
    }


def rel(variable: str, label: str, **extra) -> dict:
    relationship = {
        "variable": variable,
        "alias_mode": "define",
        "type": "POINTS_TO",
        "attributive_label": label,
        "properties": [],
    }
    relationship.update(extra)
    return {"kind": "relationship", "relationship": relationship}


def builder_config(*patterns: list, read_traversal: str | None = None) -> dict:
    query: dict = {
        "operation": "read",
        "match": [
            {
                "label": "STEP",
                "optional": False,
                "patterns": [{"path": list(path)} for path in patterns],
            }
        ],
        "return": {"distinct": False, "items": []},
    }
    if read_traversal:
        query["read_traversal"] = read_traversal
    return {"version": 1, "query": query, "runtimeEnabled": True}


# --- scope resolution -------------------------------------------------------
# READ_NOTEBOOK_ID -[SEND_TO_DISCORD]-> CALL_DISCORD -[LOOP]-> CALL_DISCORD
DISCORD_PATH = builder_config(
    [
        define_node("n76", "READ_NOTEBOOK_ID"),
        rel("r80", "SEND_TO_DISCORD"),
        define_node("n79", "CALL_DISCORD"),
        rel("r112", "LOOP"),
        reference_node("n79", "CALL_DISCORD"),
    ]
)

scope = sequence_scope.resolve_sequence_scope(
    {"builder_config": DISCORD_PATH, "cypher": ["MATCH (a)-[r]->(b) RETURN *"]}
)
check("an explicit path resolves to path mode", scope["mode"] == sequence_scope.MODE_PATH)
check(
    "the path's steps are reported in order, deduped",
    scope["step_labels"] == ["READ_NOTEBOOK_ID", "CALL_DISCORD"],
)
check(
    "each drawn hop becomes a declared edge",
    scope["edges"]
    == [
        ("READ_NOTEBOOK_ID", "CALL_DISCORD", "SEND_TO_DISCORD"),
        ("CALL_DISCORD", "CALL_DISCORD", "LOOP"),
    ],
)
check("the entry is the first step on the path", scope["entry_label"] == "READ_NOTEBOOK_ID")

single = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config([define_node("s1", "CALL_DISCORD")]),
        "cypher": ["MATCH (step:STEP { attributive_label: 'CALL_DISCORD' }) RETURN *"],
    }
)
check("one node and no hop is single mode", single["mode"] == sequence_scope.MODE_SINGLE)

downstream = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [define_node("s1", "READ_NOTEBOOK_ID")], read_traversal="downstream"
        ),
        "cypher": ["MATCH path = (:STEP { attributive_label: 'X' })-[*]->(d) RETURN path"],
    }
)
check(
    "the Return downstream toggle still means walk everything",
    downstream["mode"] == sequence_scope.MODE_OPEN,
)

variable_length = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [
                define_node("a", "STEP_A"),
                rel("r", "NEXT", length={"min": 1, "max": 3}),
                define_node("b", "STEP_B"),
            ]
        ),
        "cypher": [],
    }
)
check(
    "a variable-length hop cannot be scoped, so it walks open",
    variable_length["mode"] == sequence_scope.MODE_OPEN,
)

unnamed = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [define_node("a", "STEP_A"), rel("r", ""), define_node("b", "STEP_B")]
        ),
        "cypher": [],
    }
)
check(
    "an unnamed hop is recorded as a wildcard, not dropped",
    unnamed["edges"] == [("STEP_A", "STEP_B", sequence_scope.WILDCARD_RELATIONSHIP)],
)

parameterized = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [define_node("a", "STEP_A"), rel("r", "$edge"), define_node("b", "STEP_B")]
        ),
        "cypher": [],
    }
)
check(
    "a $parameter hop is a wildcard too — its edge is only known at run time",
    parameterized["edges"] == [("STEP_A", "STEP_B", sequence_scope.WILDCARD_RELATIONSHIP)],
)

incoming = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [
                define_node("a", "STEP_A"),
                rel("r", "FEEDS", direction="incoming"),
                define_node("b", "STEP_B"),
            ]
        ),
        "cypher": [],
    }
)
check(
    "an incoming hop declares the edge in graph direction",
    incoming["edges"] == [("STEP_B", "STEP_A", "FEEDS")],
)

branch = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [define_node("a", "STEP_A"), rel("r1", "NEXT"), define_node("b", "STEP_B")],
            [reference_node("a", "STEP_A"), rel("r2", "OTHERWISE"), define_node("c", "STEP_C")],
        ),
        "cypher": [],
    }
)
check(
    "a branch pattern referencing an earlier alias contributes its edge",
    branch["edges"]
    == [("STEP_A", "STEP_B", "NEXT"), ("STEP_A", "STEP_C", "OTHERWISE")],
)
check(
    "a branch's target joins the step set",
    branch["step_labels"] == ["STEP_A", "STEP_B", "STEP_C"],
)

parameter_node = sequence_scope.resolve_sequence_scope(
    {
        "builder_config": builder_config(
            [define_node("a", "$whichStep"), rel("r", "NEXT"), define_node("b", "STEP_B")]
        ),
        "cypher": ["MATCH (a)-[r]->(b) RETURN *"],
    }
)
check(
    "a node we cannot pin to a STEP falls back rather than composing a partial walk",
    parameter_node["mode"] == sequence_scope.MODE_OPEN,
)


# --- legacy rows (no builder_config) ----------------------------------------
check(
    "no snapshot plus a hop keeps the old open walk",
    sequence_scope.resolve_sequence_scope(
        {"cypher": ["MATCH (a:STEP)-[:POINTS_TO]->(b:STEP) RETURN *"]}
    )["mode"]
    == sequence_scope.MODE_OPEN,
)
check(
    "no snapshot and no hop is still a single step",
    sequence_scope.resolve_sequence_scope(
        {"cypher": ["MATCH (n:STEP { attributive_label: 'X' }) RETURN *"]}
    )["mode"]
    == sequence_scope.MODE_SINGLE,
)
check(
    "a snapshot recording no hop is overruled by Cypher that walks open",
    sequence_scope.resolve_sequence_scope(
        {
            "builder_config": builder_config([define_node("s1", "STEP_A")]),
            "cypher": ["MATCH path = (:STEP { attributive_label: 'STEP_A' })-[*]->(d) RETURN path"],
        }
    )["mode"]
    == sequence_scope.MODE_OPEN,
)
check(
    "an unreadable snapshot degrades instead of raising",
    sequence_scope.resolve_sequence_scope({"builder_config": "not json", "cypher": []})["mode"]
    == sequence_scope.MODE_SINGLE,
)
check("a missing row degrades to single", sequence_scope.resolve_sequence_scope(None)["mode"] == sequence_scope.MODE_SINGLE)


# --- compose ----------------------------------------------------------------
# The shared graph the two Discord sequences live on. READ_NOTEBOOK_ID also carries a
# stray NEXT edge to CALL_DISCORD (the sibling that used to be indistinguishable), and
# CALL_DISCORD sits in two different cycles: its own LOOP, and a counting cycle with
# DECREMENT.
ENTITIES = {
    "read": {
        "attributive_label": "READ_NOTEBOOK_ID",
        "payload": {"query_id": "Q_READ"},
        "parameters": [],
    },
    "discord": {
        "attributive_label": "CALL_DISCORD",
        "payload": {"endpoint": "https://example.test/webhook", "response_parameters": []},
        "parameters": [],
    },
    "decrement": {
        "attributive_label": "DECREMENT_REMAINING",
        "payload": {"query_id": "Q_DECREMENT"},
        "parameters": [],
    },
    "audit": {
        "attributive_label": "AUDIT",
        "payload": {"query_id": "Q_AUDIT"},
        "parameters": [],
    },
}


def edge(target: str, label: str) -> dict:
    return {"target": target, "attributive_label": label, "condition": "", "condition_type": ""}


ADJACENCY = {
    "read": [edge("discord", "SEND_TO_DISCORD"), edge("discord", "NEXT")],
    "discord": [
        edge("discord", "LOOP"),
        edge("decrement", "COUNT_DOWN"),
        edge("audit", "NEXT"),
    ],
    "decrement": [edge("discord", "AGAIN")],
}


def sequence_row(qid: str, cypher: list, config: dict | None = None, loop: dict | None = None) -> dict:
    return {
        "id": qid,
        "name": qid,
        "kind": "sequence",
        "operation": "read",
        "cypher": cypher,
        "parameters": [],
        "runtime_enabled": 1,
        "triggerable": 1,
        "suspended": 0,
        "loop_config": loop or {},
        "builder_config": config or {},
    }


def operation_row(qid: str, cypher: str = "") -> dict:
    return {
        "id": qid,
        "name": qid,
        "kind": "operation",
        "operation": "read",
        "cypher": [cypher] if cypher else [],
        "parameters": [],
        "runtime_enabled": 1,
        "triggerable": 1,
        "suspended": 0,
        "loop_config": {},
        "builder_config": {},
    }


ROWS: dict[str, dict] = {
    "Q_READ": operation_row("Q_READ", "MATCH (n) RETURN n.id AS message"),
    "Q_DECREMENT": operation_row(
        "Q_DECREMENT", "MATCH (n) RETURN toInteger($remaining) - 1 AS remaining"
    ),
    "Q_AUDIT": operation_row("Q_AUDIT"),
    # For-each over the notebook ids: the drawn path is the two Discord hops only.
    "SEQ_FOR_EACH": sequence_row(
        "SEQ_FOR_EACH",
        ["MATCH (a)-[r]->(b)-[r2]->(b) RETURN *"],
        DISCORD_PATH,
        {"type": "for_each", "source": "message"},
    ),
    # A different cycle through the same shared CALL_DISCORD step.
    "SEQ_COUNTDOWN": sequence_row(
        "SEQ_COUNTDOWN",
        ["MATCH (a)-[r]->(b)-[r2]->(a) RETURN *"],
        builder_config(
            [
                define_node("d1", "CALL_DISCORD"),
                rel("e1", "COUNT_DOWN"),
                define_node("d2", "DECREMENT_REMAINING"),
                rel("e2", "AGAIN"),
                reference_node("d1", "CALL_DISCORD"),
            ]
        ),
        {"type": "for", "count": 2},
    ),
    # Same entry step, but the old open walk.
    "SEQ_OPEN": sequence_row(
        "SEQ_OPEN",
        ["MATCH path = (:STEP { attributive_label: 'READ_NOTEBOOK_ID' })-[*]->(d) RETURN path"],
        builder_config([define_node("s1", "READ_NOTEBOOK_ID")], read_traversal="downstream"),
    ),
    # An unnamed hop: any POINTS_TO between the pair.
    "SEQ_WILDCARD": sequence_row(
        "SEQ_WILDCARD",
        ["MATCH (a)-[r]->(b) RETURN *"],
        builder_config(
            [
                define_node("w1", "READ_NOTEBOOK_ID"),
                rel("w2", ""),
                define_node("w3", "CALL_DISCORD"),
            ]
        ),
    ),
}

_orig_entities = execution_compose._load_step_entities
_orig_adjacency = execution_compose._load_step_adjacency
_orig_fetch = catalog.fetch_query_for_compose

execution_compose._load_step_entities = lambda space_id: ENTITIES  # type: ignore[assignment]
execution_compose._load_step_adjacency = lambda space_id, entities=None: ADJACENCY  # type: ignore[assignment]
catalog.fetch_query_for_compose = lambda qid: ROWS.get((qid or "").strip())  # type: ignore[assignment]


def transitions(package: dict, step_id: str) -> set[str]:
    for step in package.get("steps") or []:
        if step["id"] == step_id:
            return {tr["id"] for tr in step.get("next") or []}
    return set()


def step_ids(package: dict) -> set[str]:
    return {step["id"] for step in package.get("steps") or []}


try:
    for_each = execution.compose_execution_package("SP", "SEQ_FOR_EACH")
    check(
        "a path-scoped sequence contains only the steps it drew",
        step_ids(for_each) == {"read", "discord"},
    )
    check(
        "an undeclared edge off a scoped step is not walked",
        transitions(for_each, "discord") == {"discord"},
    )
    check(
        "the declared self-loop survives as the sequence's one cycle",
        (for_each.get("loop") or {}).get("back_edge") == {"from": "discord", "to": "discord"},
    )
    check(
        "a sibling NEXT between the same pair is not mistaken for the named hop",
        len([tr for tr in for_each["steps"][0]["next"] if tr["id"] == "discord"]) == 1,
    )

    countdown = execution.compose_execution_package("SP", "SEQ_COUNTDOWN")
    check(
        "a second sequence through the shared step composes its own cycle",
        step_ids(countdown) == {"discord", "decrement"},
    )
    check(
        "the shared step's other edges stay out of the second package",
        transitions(countdown, "discord") == {"decrement"},
    )
    check(
        "two cycles through one shared STEP no longer collide",
        (countdown.get("loop") or {}).get("back_edge") == {"from": "decrement", "to": "discord"},
    )

    open_walk = execution.compose_execution_package("SP", "SEQ_OPEN")
    check(
        "an open sequence still reaches everything downstream",
        step_ids(open_walk) == {"read", "discord", "decrement", "audit"},
    )
    check(
        "an open sequence keeps every edge on a step",
        transitions(open_walk, "discord") == {"discord", "decrement", "audit"},
    )

    wildcard = execution.compose_execution_package("SP", "SEQ_WILDCARD")
    check(
        "an unnamed hop matches any POINTS_TO between the pair",
        step_ids(wildcard) == {"read", "discord"}
        and transitions(wildcard, "read") == {"discord"},
    )
    check(
        "an unnamed hop still does not leave the drawn path",
        transitions(wildcard, "discord") == set(),
    )

    operation_ids = execution.enumerate_sequence_operation_ids("SP", "SEQ_FOR_EACH")
    check(
        "operation enumeration is scoped to the drawn path too",
        operation_ids == {"Q_READ"},
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
