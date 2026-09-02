"""
Diagnostic test for looping sequences in the execution engine.

A looping sequence is two halves that must agree: the graph supplies the cycle (a
POINTS_TO edge back to an earlier STEP) and the sequence type supplies the rule that
ends it. This covers both.

  - ``execution_loop``: back-edge detection, cycle body computation, config
    normalization/validation, and the guard comparison operators.
  - ``execution.run_execution`` end to end for each type: `for` with N / 1 / 0,
    `for_while` pre-test both ways plus a non-terminating loop hitting the cap,
    `for_each` over 3 / 1 / 0 rows binding every column of the current row.
  - The invariants that make iteration mean anything: derived RETURN columns re-bind
    each pass, ``auto_generate`` ids re-mint into distinct entities, caller input
    persists without a second prompt, and a fan-in outside the cycle still runs once.
  - Backward compatibility: a `dag` sequence with a back-edge stays single-pass.
  - A HITL pause mid-loop resumes on the iteration it stopped on.
  - ``execution_compose``: the descriptor and alias catalog it hands the executor, the
    configs it refuses (no cycle, two cycles, an unknown condition name), and the
    nested-sequence ban.

Steps are stubbed by replacing ``execution_run._execute_step``, so the run touches
neither Neo4j nor any HTTP endpoint. The catalog points at a throwaway SQLite DB. The
compose section stubs the two graph loaders and the catalog lookup instead, so it needs
no space at all.

Run: ``python tests/sequence-loop-execution.py`` from the repo root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    config,
    execution,
    execution_compose,
    execution_loop,
    execution_run,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def step(step_id: str, targets=None, query_id: str = "", parameters=None) -> dict:
    """A step whose execution is stubbed; `query_id` marks it as query-backed."""
    return {
        "id": step_id,
        "query_id": query_id,
        "endpoint": "",
        "headers": {},
        "body": {},
        "parameters": parameters or [],
        "next": [
            {"id": t, "condition_parameter": ""} if isinstance(t, str) else t
            for t in (targets or [])
        ],
    }


def steps_by_id(*rows: dict) -> dict[str, dict]:
    return {row["id"]: row for row in rows}


# --- back-edge detection and cycle body -------------------------------------
# A -> B -> C, with C looping back to B and exiting to D.
LOOP_GRAPH = steps_by_id(
    step("A", ["B"]),
    step("B", ["C"]),
    step("C", ["B", "D"]),
    step("D"),
)

check(
    "the edge back to an earlier step is the back-edge",
    execution_loop.find_back_edges(LOOP_GRAPH, "A") == [("C", "B")],
)
check(
    "the body is the cycle only — not the step before it, nor the exit",
    execution_loop.cycle_body(LOOP_GRAPH, "C", "B") == ["B", "C"],
)

SELF_LOOP = steps_by_id(step("A", ["B"]), step("B", ["B", "C"]), step("C"))
check(
    "a step pointing at itself is a cycle of one",
    execution_loop.find_back_edges(SELF_LOOP, "A") == [("B", "B")]
    and execution_loop.cycle_body(SELF_LOOP, "B", "B") == ["B"],
)

DIAMOND = steps_by_id(step("A", ["B", "C"]), step("B", ["D"]), step("C", ["D"]), step("D"))
check(
    "a diamond fan-in is not a cycle",
    execution_loop.find_back_edges(DIAMOND, "A") == [],
)

TWO_CYCLES = steps_by_id(
    step("A", ["B"]), step("B", ["C"]), step("C", ["B", "D"]), step("D", ["A"])
)
check(
    "two back-edges are both found",
    len(execution_loop.find_back_edges(TWO_CYCLES, "A")) == 2,
)


# --- analyze_loop: what the graph must support ------------------------------
def analyze_error(steps: dict, loop_config: dict) -> str:
    try:
        execution_loop.analyze_loop(steps, loop_config, next(iter(steps), None))
    except ValueError as err:
        return str(err)
    return ""


check(
    "a loop type with no cycle is rejected",
    "no" in analyze_error(DIAMOND, {"type": "for", "count": 2}).lower(),
)
check(
    "a loop type with two cycles is rejected",
    "exactly one" in analyze_error(TWO_CYCLES, {"type": "for", "count": 2}),
)
check(
    "a dag sequence with a back-edge is not rejected",
    execution_loop.analyze_loop(TWO_CYCLES, {"type": "dag"}, "A") is None,
)
check(
    "an absent loop_config means dag",
    execution_loop.analyze_loop(LOOP_GRAPH, {}, "A") is None
    and execution_loop.analyze_loop(LOOP_GRAPH, None, "A") is None,
)

descriptor = execution_loop.analyze_loop(
    LOOP_GRAPH, {"type": "for", "count": 3}, "A"
)
check(
    "the descriptor names the back-edge and the body",
    descriptor["back_edge"] == {"from": "C", "to": "B"} and descriptor["body"] == ["B", "C"],
)
check(
    "max_iterations defaults rather than being left unset",
    descriptor["max_iterations"] == execution_loop.DEFAULT_MAX_ITERATIONS,
)
for_each_descriptor = execution_loop.analyze_loop(
    LOOP_GRAPH, {"type": "for_each", "source": "rowId"}, "A", {"rowId": "A"}
)
check(
    "a for_each descriptor pins the step that projects its source",
    for_each_descriptor["source_step"] == "A",
)


# --- config validation ------------------------------------------------------
def problems(raw: dict, available: set, iterable: set | None = None) -> list[str]:
    return execution_loop.validate_loop_config(
        execution_loop.normalize_loop_config(raw), available, iterable
    )


check("a dag config needs nothing", problems({"type": "dag"}, set()) == [])
check("a valid for config passes", problems({"type": "for", "count": 3}, set()) == [])
check(
    "a for count beyond max_iterations is rejected",
    len(problems({"type": "for", "count": 50, "max_iterations": 10}, set())) == 1,
)
check(
    "for_while needs a parameter",
    len(problems({"type": "for_while", "condition": {"operator": "="}}, set())) > 0,
)
check(
    "for_while rejects a parameter nothing publishes",
    len(
        problems(
            {"type": "for_while", "condition": {"parameter": "nope", "operator": "="}},
            {"other"},
        )
    )
    == 1,
)
check(
    "for_while accepts a known parameter",
    problems(
        {"type": "for_while", "condition": {"parameter": "hasMore", "operator": "="}},
        {"hasMore"},
    )
    == [],
)
check(
    "for_each only accepts a RETURN alias, not any resolvable name",
    len(problems({"type": "for_each", "source": "callerInput"}, {"callerInput"}, set())) == 1
    and problems({"type": "for_each", "source": "rows"}, {"rows"}, {"rows"}) == [],
)
check(
    "an unrecognized type degrades to dag rather than failing",
    execution_loop.normalize_loop_config({"type": "spiral"})["type"] == "dag",
)


# --- comparison operators ---------------------------------------------------
CASES = [
    (True, "=", "true", True),
    (True, "=", "false", False),
    (False, "=", "false", True),
    ("true", "=", "true", True),
    (3, "<", "5", True),
    (5, "<", "5", False),
    ("3", ">=", 3, True),
    (10, ">", "9", True),
    ("10", ">", "9", True),  # numeric, not lexical ("10" < "9" as text)
    ("abc", "CONTAINS", "b", True),
    ("abc", "STARTS WITH", "a", True),
    ("abc", "ENDS WITH", "z", False),
    (None, "=", "true", False),
    (None, "<>", "true", True),
    ("x", "<>", "y", True),
]
for left, operator, right, expected in CASES:
    check(
        f"compare({left!r} {operator} {right!r}) is {expected}",
        execution_loop.compare(left, operator, right) is expected,
    )
check(
    "an unresolved for_while parameter ends the loop",
    execution_loop.condition_holds({"parameter": "flag", "operator": "=", "value": "true"}, {})
    is False,
)


# --- end-to-end runs --------------------------------------------------------
tmpdir = tempfile.mkdtemp(prefix="pona-flow-loop-test-")
_original_catalog_path = config.catalog_sqlite_path
_original_execute_step = execution_run._execute_step
config.catalog_sqlite_path = lambda: Path(tmpdir) / "data.db"  # type: ignore[assignment]

# Steps see this on every pass; each entry is (step_id, snapshot of watched values).
observed: list[tuple[str, dict]] = []
# Per-step canned responses, keyed by step id. A callable is invoked with the pass index.
responses: dict = {}
WATCH = ("entityId", "role", "id__new", "note", "hasMore")


def fake_execute_step(space_id: str, step_row: dict, resolved: dict) -> dict:
    step_id = step_row["id"]
    observed.append((step_id, {k: resolved.get(k) for k in WATCH if k in resolved}))
    canned = responses.get(step_id)
    if callable(canned):
        return canned(sum(1 for sid, _ in observed if sid == step_id) - 1)
    return canned or {}


execution_run._execute_step = fake_execute_step  # type: ignore[assignment]


def run(package: dict, params=None, trigger: str = "webhook") -> tuple[dict, str]:
    state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
    result = execution.run_execution("SP_TEST", state_id, params=params, trigger=trigger)
    return result, state_id


def trace(result: dict) -> list[str]:
    return [entry["step_id"] for entry in result.get("executed") or []]


def loop_package(loop: dict | None, extra_steps=None, tail_targets=("B", "D")) -> dict:
    """A -> B -> C, C looping to B and exiting to D (A and D sit outside the cycle)."""
    rows = [
        step("A", ["B"], query_id="Q_A"),
        step("B", ["C"], query_id="Q_B"),
        step("C", list(tail_targets), query_id="Q_C"),
        step("D", query_id="Q_D"),
    ]
    package = {
        "steps": rows + list(extra_steps or []),
        "response_parameters": [],
        "sequence_query_id": "SEQ_LOOP",
        "space_id": "SP_TEST",
    }
    if loop:
        package["loop"] = {
            "max_iterations": execution_loop.DEFAULT_MAX_ITERATIONS,
            "back_edge": {"from": "C", "to": "B"},
            "body": ["B", "C"],
            **loop,
        }
    return package


try:
    # --- for ---------------------------------------------------------------
    observed.clear()
    responses.clear()
    result, _ = run(loop_package({"type": "for", "count": 3}))
    check("for 3: the body runs three times", trace(result) == ["A", "B", "C"] * 1 + ["B", "C", "B", "C", "D"])
    check(
        "for 3: steps outside the cycle run exactly once",
        trace(result).count("A") == 1 and trace(result).count("D") == 1,
    )
    check(
        "for 3: each body pass is stamped with its iteration",
        [e.get("iteration") for e in result["executed"] if e["step_id"] == "B"] == [0, 1, 2],
    )

    observed.clear()
    result, _ = run(loop_package({"type": "for", "count": 1}))
    check("for 1: the body runs once", trace(result) == ["A", "B", "C", "D"])

    observed.clear()
    result, _ = run(loop_package({"type": "for", "count": 0}))
    check("for 0: the body is skipped and the run continues", trace(result) == ["A", "D"])

    # --- dag backward compatibility ----------------------------------------
    observed.clear()
    result, _ = run(loop_package(None))
    check(
        "dag: the same graph with a back-edge stays single-pass",
        trace(result) == ["A", "B", "C", "D"],
    )
    check(
        "dag: no iteration stamps appear",
        all("iteration" not in e for e in result["executed"]),
    )

    # --- for_while ---------------------------------------------------------
    observed.clear()
    responses.clear()
    condition = {"parameter": "hasMore", "operator": "=", "value": "true"}
    # The tail re-binds hasMore each pass; it flips false on the third.
    responses["C"] = lambda index: {"records": [{"hasMore": index < 2}]}
    result, _ = run(loop_package({"type": "for_while", "condition": condition}), params={"hasMore": "true"})
    check(
        "for_while: the loop ends when the re-bound condition goes false",
        trace(result) == ["A", "B", "C", "B", "C", "B", "C", "D"],
    )

    observed.clear()
    responses.clear()
    result, _ = run(
        loop_package({"type": "for_while", "condition": condition}), params={"hasMore": "false"}
    )
    check(
        "for_while: an already-false condition skips the body (pre-test)",
        trace(result) == ["A", "D"],
    )

    observed.clear()
    responses.clear()
    result, _ = run(
        loop_package({"type": "for_while", "condition": condition, "max_iterations": 5}),
        params={"hasMore": "true"},
    )
    check("for_while: a condition that never goes false errors", result["status"] == "error")
    check("for_while: the error names the cap", "5 iterations" in result.get("message", ""))
    check(
        "for_while: the run stops at the cap rather than spinning",
        trace(result).count("B") == 5,
    )

    # --- derived-key clearing ----------------------------------------------
    # Without clearing, `hasMore` would freeze at its first value and never terminate.
    observed.clear()
    responses.clear()
    responses["C"] = lambda index: {"records": [{"hasMore": index < 1}]}
    result, _ = run(
        loop_package({"type": "for_while", "condition": condition, "max_iterations": 20}),
        params={"hasMore": "true"},
    )
    check(
        "a RETURN column bound inside the body re-binds each pass",
        trace(result) == ["A", "B", "C", "B", "C", "D"],
    )

    # --- id re-minting -----------------------------------------------------
    observed.clear()
    responses.clear()
    minting = loop_package({"type": "for", "count": 3})
    for row in minting["steps"]:
        if row["id"] == "B":
            row["parameters"] = [
                {"name": "id__new", "is_required": False, "value_type": "UID", "auto_generate": True}
            ]
    result, _ = run(minting)
    minted = [values.get("id__new") for sid, values in observed if sid == "B"]
    check("each pass mints a fresh auto_generate id", len(set(minted)) == 3)
    check("every minted id is present", all(minted))

    # --- caller input persists ---------------------------------------------
    observed.clear()
    responses.clear()
    with_param = loop_package({"type": "for", "count": 3})
    for row in with_param["steps"]:
        if row["id"] == "B":
            row["parameters"] = [{"name": "note", "is_required": True, "value_type": "string"}]
    result, _ = run(with_param, params={"note": "hello"})
    notes = [values.get("note") for sid, values in observed if sid == "B"]
    check("caller input survives every iteration boundary", notes == ["hello"] * 3)
    check("the run completes without re-prompting", result["status"] != "pending")

    # --- HITL pause and resume mid-loop ------------------------------------
    observed.clear()
    responses.clear()
    paused, state_id = run(with_param, trigger="manual")
    check("a required input inside the body pauses the run", paused["status"] == "pending")
    check("it pauses at the body step that needs it", paused.get("step_id") == "B")
    stored = catalog.fetch_state_package(state_id)
    check(
        "loop state is persisted for the resume",
        isinstance((stored.get("progress") or {}).get("loop"), dict),
    )
    resumed = execution.run_execution(
        "SP_TEST", state_id, params={"note": "answered"}, trigger="manual"
    )
    check(
        "resuming completes the remaining iterations",
        trace(resumed) == ["B", "C", "B", "C", "B", "C", "D"],
    )
    check(
        "the answer given once is reused, not re-asked",
        [values.get("note") for sid, values in observed if sid == "B"] == ["answered"] * 3,
    )

    # --- for_each ----------------------------------------------------------
    ROWS = [
        {"entityId": "E1", "role": "subject"},
        {"entityId": "E2", "role": "predicate"},
        {"entityId": "E3", "role": "object"},
    ]

    def for_each_package(rows: list[dict]) -> dict:
        """A projects the rows (outside the cycle); B/C iterate them."""
        package = loop_package(
            {"type": "for_each", "source": "entityId", "source_step": "A"}
        )
        responses["A"] = {"records": rows}
        return package

    observed.clear()
    responses.clear()
    result, _ = run(for_each_package(ROWS))
    check("for_each: one pass per row", trace(result) == ["A", "B", "C", "B", "C", "B", "C", "D"])
    seen = [values for sid, values in observed if sid == "B"]
    check(
        "for_each: each pass binds the current row's id",
        [values.get("entityId") for values in seen] == ["E1", "E2", "E3"],
    )
    check(
        "for_each: every column of the row is bound, not just the source",
        [values.get("role") for values in seen] == ["subject", "predicate", "object"],
    )

    observed.clear()
    responses.clear()
    result, _ = run(for_each_package([{"entityId": "ONLY", "role": "x"}]))
    check("for_each: a single row runs the body once", trace(result) == ["A", "B", "C", "D"])

    observed.clear()
    responses.clear()
    result, _ = run(for_each_package([]))
    check("for_each: an empty result set skips the body", trace(result) == ["A", "D"])

    # --- fan-in outside the cycle ------------------------------------------
    # A -> B -> C; C loops to B, exits to D and E; both D and E point at F.
    # F must run once at the end, not once per pass.
    observed.clear()
    responses.clear()
    fan_in = loop_package(
        {"type": "for", "count": 3},
        extra_steps=[step("E", ["F"], query_id="Q_E"), step("F", query_id="Q_F")],
        tail_targets=("B", "D", "E"),
    )
    for row in fan_in["steps"]:
        if row["id"] == "D":
            row["next"] = [{"id": "F", "condition_parameter": ""}]
    result, _ = run(fan_in)
    check("fan-in after the loop runs once", trace(result).count("F") == 1)
    check(
        "both exit branches run once",
        trace(result).count("D") == 1 and trace(result).count("E") == 1,
    )
    check("the body still ran three times", trace(result).count("B") == 3)

    # --- a conditional back-edge can also stop the loop --------------------
    observed.clear()
    responses.clear()
    guarded = loop_package(
        {"type": "for", "count": 5},
        tail_targets=(
            {"id": "B", "condition_parameter": "keepGoing", "condition_expected": True},
            {"id": "D", "condition_parameter": ""},
        ),
    )
    result, _ = run(guarded, params={"keepGoing": "false"})
    check(
        "a false guard on the back-edge ends the loop before its count",
        trace(result) == ["A", "B", "C", "D"],
    )
finally:
    config.catalog_sqlite_path = _original_catalog_path  # type: ignore[assignment]
    execution_run._execute_step = _original_execute_step  # type: ignore[assignment]


# --- compose ----------------------------------------------------------------
# The executor is handed a `loop` descriptor; these are the checks that produce it.
# The STEP graph normally comes from SQLite plus Neo4j, so both loaders are stubbed
# and the catalog is answered from a dict — nothing here touches a real space.
_original_load_entities = execution_compose._load_step_entities
_original_load_adjacency = execution_compose._load_step_adjacency
_original_fetch_for_compose = catalog.fetch_query_for_compose

SEQ_CYPHER = ["MATCH path = (:STEP { attributive_label: 'STEP_A' })-[*]->(n) RETURN path"]


def operation_row(query_id: str, cypher: str = "") -> dict:
    return {
        "id": query_id,
        "name": query_id,
        "kind": "operation",
        "operation": "read",
        "cypher": [cypher] if cypher else [],
        "parameters": [],
        "runtime_enabled": 1,
        "triggerable": 1,
        "suspended": 0,
        "loop_config": {},
    }


def compose_space(loop_config: dict, adjacency_pairs, queries=None, step_queries=None) -> dict:
    """Compose a package for the A -> B -> C graph with the given back-edges."""
    labels = {"A": "STEP_A", "B": "STEP_B", "C": "STEP_C", "D": "STEP_D"}
    step_queries = step_queries or {}
    entities = {
        sid: {
            "attributive_label": label,
            "payload": {"query_id": step_queries.get(sid, f"Q_{sid}")},
            "parameters": [],
        }
        for sid, label in labels.items()
    }
    adjacency: dict[str, list[dict]] = {}
    for source, target in adjacency_pairs:
        adjacency.setdefault(source, []).append(
            {"id": f"R_{source}{target}", "target": target, "condition": "", "condition_type": ""}
        )

    rows = {
        "SEQ": {
            "id": "SEQ",
            "name": "Looping sequence",
            "kind": "sequence",
            "operation": "read",
            "cypher": SEQ_CYPHER,
            "parameters": [],
            "runtime_enabled": 1,
            "triggerable": 1,
            "suspended": 0,
            "loop_config": loop_config,
        },
        # B projects two aliases, so it can stand in as a for-each row source.
        "Q_B": operation_row("Q_B", "MATCH (n) RETURN n.id AS entityId, n.role AS role"),
    }
    rows.update(queries or {})
    for sid in labels:
        rows.setdefault(f"Q_{sid}", operation_row(f"Q_{sid}"))

    execution_compose._load_step_entities = lambda space_id: entities  # type: ignore[assignment]
    execution_compose._load_step_adjacency = (  # type: ignore[assignment]
        lambda space_id, ents=None: adjacency
    )
    catalog.fetch_query_for_compose = lambda qid: rows.get((qid or "").strip())  # type: ignore[assignment]
    return execution_compose.compose_execution_package("SP_TEST", "SEQ")


CYCLE = [("A", "B"), ("B", "C"), ("C", "B"), ("C", "D")]


def compose_error(loop_config: dict, adjacency_pairs=None, queries=None, step_queries=None) -> str:
    try:
        compose_space(loop_config, adjacency_pairs or CYCLE, queries, step_queries)
    except (ValueError, PermissionError) as exc:
        return str(exc)
    return ""


try:
    package = compose_space({"type": "for", "count": 3}, CYCLE)
    check("compose emits a loop descriptor for a loop type", "loop" in package)
    check(
        "compose finds the back-edge structurally, without it being authored",
        package["loop"]["back_edge"] == {"from": "C", "to": "B"},
    )
    check("compose scopes the body to the cycle", package["loop"]["body"] == ["B", "C"])
    check(
        "compose carries the termination rule through",
        package["loop"]["type"] == "for" and package["loop"]["count"] == 3,
    )
    check(
        "compose defaults the safety cap",
        package["loop"]["max_iterations"] == execution_loop.DEFAULT_MAX_ITERATIONS,
    )

    check(
        "compose publishes the alias catalog the builder's pickers draw on",
        {"step_id": "B", "label": "STEP_B", "aliases": ["entityId", "role"]}
        in package["available_parameters"],
    )

    # A dag sequence over the same cyclic graph is left exactly as it was.
    dag_package = compose_space({}, CYCLE)
    check("compose emits no descriptor for a dag", "loop" not in dag_package)
    check("a dag still composes its cyclic graph", len(dag_package["steps"]) == 4)

    check(
        "a loop type with no cycle is rejected at compose",
        "no cycle" in compose_error({"type": "for", "count": 2}, [("A", "B"), ("B", "C")]),
    )
    check(
        "a loop type with two cycles is rejected at compose",
        "2 cycles" in compose_error(
            {"type": "for", "count": 2},
            [("A", "B"), ("B", "C"), ("C", "B"), ("C", "D"), ("D", "A")],
        ),
    )

    check(
        "for_while against an unknown name is rejected at compose",
        "not a parameter of this sequence"
        in compose_error(
            {"type": "for_while", "condition": {"parameter": "nope", "operator": "=", "value": "x"}}
        ),
    )
    check(
        "for_while against a real alias composes",
        compose_error(
            {
                "type": "for_while",
                "condition": {"parameter": "entityId", "operator": "<>", "value": ""},
            }
        )
        == "",
    )
    check(
        "for_each over a non-alias is rejected at compose",
        "not a RETURN alias"
        in compose_error({"type": "for_each", "source": "somethingElse"}),
    )

    # for_each has to name the step that produces its rows: an empty result set has no
    # row to recognize the alias in, so without the step id the executor could not tell
    # "the source returned nothing" from "this step is not the source".
    for_each_package = compose_space({"type": "for_each", "source": "entityId"}, CYCLE)
    check(
        "compose pins a for_each source to the step that projects it",
        for_each_package["loop"]["source_step"] == "B",
    )

    # --- nesting ban -------------------------------------------------------
    nested_sequence = {
        "Q_C": {
            "id": "Q_C",
            "name": "Inner sequence",
            "kind": "sequence",
            "operation": "read",
            "cypher": SEQ_CYPHER,
            "parameters": [],
            "runtime_enabled": 1,
            "triggerable": 1,
            "suspended": 0,
            "loop_config": {},
        }
    }
    message = compose_error({}, CYCLE, nested_sequence)
    check("a step running another sequence is rejected", "Nested sequences" in message)
    check("the rejection names the offending step", "STEP_C" in message)
    check(
        "the nesting ban applies to loop types too",
        "Nested sequences" in compose_error({"type": "for", "count": 2}, CYCLE, nested_sequence),
    )
    # Every sequence is itself auto-wrapped in a STEP pointing at its own query id.
    # That self-reference is not nesting, and rejecting it would make no sequence run.
    check(
        "a sequence's own auto-wrap step is not mistaken for nesting",
        compose_error({}, CYCLE, None, {"A": "SEQ"}) == "",
    )
finally:
    execution_compose._load_step_entities = _original_load_entities  # type: ignore[assignment]
    execution_compose._load_step_adjacency = _original_load_adjacency  # type: ignore[assignment]
    catalog.fetch_query_for_compose = _original_fetch_for_compose  # type: ignore[assignment]

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
