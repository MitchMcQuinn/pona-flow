"""
Diagnostic test for operation STEPs: boolean evaluation and collision writes.

Covers:
  - group AND/OR and per-group statement junctions;
  - missing operands stay false (IS EMPTY is the exception) and the step still succeeds;
  - exists, is empty, and regex, including an invalid pattern;
  - dotted $name.field reads and a rejected $secret reference;
  - overwrite, skip, append, and sequence;
  - true / false / always assignments, including a key that matches the evaluation name;
  - compose publishes the evaluation name and assignment keys;
  - a run writes the boolean and a later edge branches on it;
  - a step with no groups fails the run.

No Neo4j. The run uses a throwaway catalog SQLite file.

Run: ``python tests/operation-step.py`` from the repo root.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import (  # noqa: E402
    catalog,
    config,
    execution,
    execution_call,
    execution_compose,
    execution_operation,
    execution_run,
)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def evaluation(groups, junction="AND", name="flag", collision="overwrite") -> dict[str, Any]:
    return {
        "name": name,
        "collision": collision,
        "group_junction": junction,
        "groups": groups,
    }


def group(statements, junction="AND") -> dict[str, Any]:
    return {"statement_junction": junction, "statements": statements}


def statement(x, operator, y=None) -> dict[str, Any]:
    row: dict[str, Any] = {"x": x, "operator": operator}
    if y is not None:
        row["y"] = y
    return row


def step(evaluation_spec, assignments=None) -> dict[str, Any]:
    return {
        "id": "OP",
        "query_id": "",
        "kind": "operation",
        "evaluation": evaluation_spec,
        "assignments": assignments or [],
    }


SENIOR = evaluation(
    [
        group(
            [
                statement("$user.email", "ENDS WITH", "@corp.example.com"),
                statement("$user.tenure_months", ">", 12),
            ]
        )
    ],
    junction="OR",
    name="account_tier_routing",
)

SENIOR_ASSIGNMENTS = [
    {"when": "true", "type": "boolean", "key": "has_seniority", "value": True},
    {"when": "true", "type": "string", "key": "priority_level", "value": "High"},
    {"when": "false", "type": "string", "key": "priority_level", "value": "Low"},
    {"when": "always", "type": "number", "key": "rules_version", "value": 1},
]


def apply_to(spec, resolved, assignments=None) -> bool:
    return execution_operation.apply(step(spec, assignments), resolved)


try:
    corp = {"user": {"email": "a@corp.example.com", "tenure_months": 18}}
    resolved = dict(corp)
    result = apply_to(SENIOR, resolved, SENIOR_ASSIGNMENTS)
    check("corp senior evaluates true", result is True)
    check("evaluation name is the boolean", resolved.get("account_tier_routing") is True)
    check("true boolean assignment writes", resolved.get("has_seniority") is True)
    check("true string assignment writes", resolved.get("priority_level") == "High")
    check("always number assignment writes", resolved.get("rules_version") == 1)
    check("false assignment did not write over the true one", resolved.get("priority_level") == "High")

    junior = {"user": {"email": "a@corp.example.com", "tenure_months": 3}, "priority_level": "Keep"}
    apply_to(SENIOR, junior, SENIOR_ASSIGNMENTS)
    check("short tenure is false", junior.get("account_tier_routing") is False)
    check("false assignment overwrites when the result is false", junior.get("priority_level") == "Low")
    check("unmatched true boolean was not introduced", "has_seniority" not in junior)
    check("always assignment still writes", junior.get("rules_version") == 1)

    missing = {}
    apply_to(
        evaluation([group([statement("$nope", "ENDS WITH", "@corp.example.com")])]),
        missing,
    )
    check("missing operand evaluates false and still writes", missing.get("flag") is False)

    empty_check = {}
    apply_to(evaluation([group([statement("$nope", "IS EMPTY")])]), empty_check)
    check("missing operand is empty", empty_check.get("flag") is True)
    present_empty = {"name": ""}
    apply_to(evaluation([group([statement("$name", "IS EMPTY")])]), present_empty)
    check("empty string is empty", present_empty.get("flag") is True)
    exists_empty = {"name": ""}
    apply_to(evaluation([group([statement("$name", "EXISTS")])], name="seen"), exists_empty)
    check("empty string exists", exists_empty.get("seen") is True)
    exists_missing = {}
    apply_to(evaluation([group([statement("$name", "EXISTS")])], name="seen"), exists_missing)
    check("missing reference does not exist", exists_missing.get("seen") is False)
    not_empty = {"count": 0, "ok_flag": False}
    apply_to(evaluation([group([statement("$count", "IS EMPTY")])], name="blank"), not_empty)
    check("zero is not empty", not_empty.get("blank") is False)
    apply_to(evaluation([group([statement("$ok_flag", "IS EMPTY")])], name="blank"), not_empty)
    check("false is not empty", not_empty.get("blank") is False)

    bad_regex = {"email": "a@corp.example.com"}
    apply_to(evaluation([group([statement("$email", "REGEX", "[")])]), bad_regex)
    check("invalid regex is false", bad_regex.get("flag") is False)
    good_regex = {"email": "a@corp.example.com"}
    apply_to(
        evaluation([group([statement("$email", "REGEX", r"@corp\.example\.com$")])]),
        good_regex,
    )
    check("regex matches", good_regex.get("flag") is True)

    both = {
        "user": {"email": "a@other.test", "tenure_months": 1},
        "vip": True,
    }
    or_groups = evaluation(
        [
            group(
                [
                    statement("$user.email", "ENDS WITH", "@corp.example.com"),
                    statement("$user.tenure_months", ">", 12),
                ]
            ),
            group([statement("$vip", "=", True)]),
        ],
        junction="OR",
    )
    apply_to(or_groups, both)
    check("group OR is true when one group holds", both.get("flag") is True)
    and_groups = evaluation(
        [
            group([statement("$vip", "=", True)]),
            group([statement("$user.tenure_months", ">", 12)]),
        ],
        junction="AND",
    )
    apply_to(and_groups, both)
    check("group AND is false when one group fails", both.get("flag") is False)
    inner_or = {"email": "nope@other.test", "tenure": 20}
    apply_to(
        evaluation(
            [
                group(
                    [
                        statement("$email", "ENDS WITH", "@corp.example.com"),
                        statement("$tenure", ">", 12),
                    ],
                    junction="OR",
                )
            ]
        ),
        inner_or,
    )
    check("statement OR is true when one statement holds", inner_or.get("flag") is True)

    secret_raised = False
    try:
        apply_to(evaluation([group([statement("$secret.API_KEY", "=", "x")])]), {})
    except ValueError as exc:
        secret_raised = "credential" in str(exc).lower()
    check("secret reference fails the step", secret_raised)

    prior = {"flag": "kept", "note": "ab"}
    apply_to(evaluation([group([statement("$note", "CONTAINS", "a")])], collision="skip"), prior)
    check("skip leaves an existing evaluation name", prior.get("flag") == "kept")
    apply_to(
        evaluation([group([statement("$note", "CONTAINS", "a")])], collision="overwrite"),
        prior,
    )
    check("overwrite replaces the evaluation name", prior.get("flag") is True)

    appended = {"label": "High"}
    apply_to(
        evaluation([group([statement(1, "=", 1)])], name="label", collision="append"),
        appended,
        [{"when": "always", "type": "string", "key": "label", "value": "!"}],
    )
    # The boolean is written first (wrap "High"), then the assignment pushes "!".
    check("append wraps a non-string then pushes", appended.get("label") == ["High", True, "!"])
    text = {"label": "High"}
    apply_to(
        evaluation([group([statement(1, "=", 1)])], name="other", collision="append"),
        text,
        [{"when": "always", "type": "string", "key": "label", "value": "!"}],
    )
    check("append concatenates strings", text.get("label") == "High!")

    sequenced = {"flag": True}
    apply_to(
        evaluation([group([statement(1, "=", 1)])], collision="sequence"),
        sequenced,
        [{"when": "always", "type": "string", "key": "flag", "value": "next"}],
    )
    check("sequence keeps the existing key", sequenced.get("flag") is True)
    check("sequence writes the evaluation on the next suffix", sequenced.get("flag_2") is True)
    check("sequence writes the assignment after that", sequenced.get("flag_3") == "next")
    apply_to(
        evaluation([group([statement(1, "=", 1)])], collision="sequence"),
        sequenced,
        [{"when": "always", "type": "string", "key": "flag", "value": "later"}],
    )
    check("sequence walks past taken suffixes", sequenced.get("flag_5") == "later")

    same_key = {}
    apply_to(
        evaluation([group([statement(1, "=", 1)])], name="flag", collision="overwrite"),
        same_key,
        [{"when": "true", "type": "string", "key": "flag", "value": "High"}],
    )
    check("later assignment wins on overwrite of the evaluation name", same_key.get("flag") == "High")
    skipped = {}
    apply_to(
        evaluation([group([statement(1, "=", 1)])], name="flag", collision="skip"),
        skipped,
        [{"when": "true", "type": "string", "key": "flag", "value": "High"}],
    )
    check("skip keeps the evaluation boolean when the assignment key matches", skipped.get("flag") is True)

    empty_groups = False
    try:
        apply_to(evaluation([]), {})
    except ValueError as exc:
        empty_groups = "group" in str(exc).lower()
    check("no groups fails instead of writing false", empty_groups)

    missing_y = False
    try:
        apply_to(evaluation([group([{"x": "$n", "operator": ">"}])]), {"n": 18})
    except ValueError as exc:
        missing_y = "Y" in str(exc)
    check("a comparison without Y fails the step", missing_y)

    payload = {
        "kind": "operation",
        "evaluation": SENIOR,
        "assignments": SENIOR_ASSIGNMENTS,
    }
    composed = execution._build_step("OP", {"payload": payload, "parameters": []}, {})
    check("compose emits operation kind", composed.get("kind") == "operation")
    check("compose copies the evaluation", composed.get("evaluation", {}).get("name") == "account_tier_routing")
    names = execution_compose._step_return_aliases(payload, lambda *_: None)
    check(
        "compose publishes ok, the evaluation name, and assignment keys",
        names == ["ok", "account_tier_routing", "has_seniority", "priority_level", "rules_version"],
    )
    check("operation steps are not retried", execution_call.is_retryable_step(composed) is False)

    # --- run: the mock branches a later edge on the written boolean ---------
    tmpdir = tempfile.mkdtemp(prefix="pona-flow-operation-test-")
    config.catalog_sqlite_path = lambda: Path(tmpdir) / "data.db"  # type: ignore[assignment]

    def run(steps: list[dict[str, Any]], params: dict[str, Any] | None = None) -> dict[str, Any]:
        package = {
            "steps": steps,
            "response_parameters": [],
            "sequence_query_id": "SEQ_OP",
            "space_id": "SP_TEST",
        }
        state_id = catalog.insert_state_package(package, status="inactive", run_start_date=None)
        return execution.run_execution("SP_TEST", state_id, params=params, trigger="webhook")

    def leaf(step_id: str) -> dict[str, Any]:
        return {
            "id": step_id,
            "query_id": "",
            "endpoint": "",
            "parameters": [],
            "next": [],
        }

    walked = run(
        [
            {
                **step(SENIOR, SENIOR_ASSIGNMENTS),
                "endpoint": "",
                "parameters": [],
                "next": [
                    {
                        "id": "YES",
                        "condition_parameter": "account_tier_routing",
                        "condition_expected": True,
                    },
                    {
                        "id": "NO",
                        "condition_parameter": "account_tier_routing",
                        "condition_expected": False,
                    },
                ],
            },
            leaf("YES"),
            leaf("NO"),
        ],
        {"user": {"email": "a@corp.example.com", "tenure_months": 18}},
    )
    trace = [entry.get("step_id") for entry in walked.get("executed") or []]
    check("run finishes", walked.get("status") == "inactive")
    check("true edge is taken", trace == ["OP", "YES"])
    check("run stored the boolean", walked.get("resolved", {}).get("account_tier_routing") is True)
    check("run stored the assignment", walked.get("resolved", {}).get("priority_level") == "High")
    check("run published ok", walked.get("resolved", {}).get("ok") is True)

    broken = run(
        [
            {
                "id": "OP",
                "query_id": "",
                "kind": "operation",
                "endpoint": "",
                "parameters": [],
                "evaluation": {"name": "flag", "collision": "overwrite", "group_junction": "AND", "groups": []},
                "assignments": [],
                "next": [],
            }
        ]
    )
    check("a step with no groups fails the run", broken.get("status") == "error")
    check("the failure names the missing groups", "group" in str(broken.get("message") or "").lower())

    # Transport binding sets ok before the operation write, so naming the
    # evaluation ok with overwrite replaces that true.
    named_ok = run(
        [
            {
                "id": "OP",
                "query_id": "",
                "kind": "operation",
                "endpoint": "",
                "parameters": [],
                "evaluation": evaluation([group([statement(1, "=", 0)])], name="ok"),
                "assignments": [],
                "next": [],
            }
        ]
    )
    check("overwrite can replace the published ok", named_ok.get("resolved", {}).get("ok") is False)
except Exception as exc:  # pragma: no cover - keep the summary honest
    check(f"unexpected error: {exc}", False)

print()
if failures:
    print(f"{len(failures)} failed:")
    for name in failures:
        print(f"  - {name}")
    sys.exit(1)
print("All operation-step checks passed.")
