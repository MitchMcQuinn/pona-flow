"""
Diagnostic test: STEP delete must treat a display-title attributive_label as the same
node as its UPPER_SNAKE form (Call Discord General Webhook ↔ CALL_DISCORD_GENERAL_WEBHOOK).

Covers ``normalize_attributive_label``, ``attributive_labels_equivalent``, and
``sequence_references_step`` without a live Neo4j store.

Run: ``python tests/step-delete-label-normalize.py`` from the repo root.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import cypher_utils, step_delete  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


check(
    "display title normalizes to UPPER_SNAKE",
    cypher_utils.normalize_attributive_label("Call Discord General Webhook")
    == "CALL_DISCORD_GENERAL_WEBHOOK",
)
check(
    "already-normalized label is unchanged",
    cypher_utils.normalize_attributive_label("CALL_DISCORD_GENERAL_WEBHOOK")
    == "CALL_DISCORD_GENERAL_WEBHOOK",
)
check(
    "$param attributive_label is preserved",
    cypher_utils.normalize_attributive_label("$stepName") == "$stepName",
)
check(
    "display title and UPPER_SNAKE are equivalent",
    cypher_utils.attributive_labels_equivalent(
        "Call Discord General Webhook", "CALL_DISCORD_GENERAL_WEBHOOK"
    ),
)
check(
    "unrelated labels are not equivalent",
    not cypher_utils.attributive_labels_equivalent("CALL_DISCORD", "CALL_SLACK"),
)
check(
    "blank labels are not equivalent",
    not cypher_utils.attributive_labels_equivalent("", "CALL_DISCORD"),
)

display_labels = {"Call Discord General Webhook"}
normalized_labels = {"CALL_DISCORD_GENERAL_WEBHOOK"}
both = display_labels | normalized_labels

check(
    "sequence MATCH on display title is found from UPPER_SNAKE delete",
    step_delete.sequence_references_step(
        {"Call Discord General Webhook"},
        {"Call Discord General Webhook"},
        normalized_labels,
        set(),
    ),
)
check(
    "sequence MATCH on UPPER_SNAKE is found from display-title delete",
    step_delete.sequence_references_step(
        {"CALL_DISCORD_GENERAL_WEBHOOK"},
        {"CALL_DISCORD_GENERAL_WEBHOOK"},
        display_labels,
        set(),
    ),
)
check(
    "unrelated sequence is ignored",
    not step_delete.sequence_references_step(
        {"READ_NOTEBOOKS"},
        {"READ_NOTEBOOKS"},
        both,
        set(),
    ),
)
check(
    "POINTS_TO relationship label still ties a sequence to the step",
    step_delete.sequence_references_step(
        {"READ_NOTEBOOKS"},
        {"READ_NOTEBOOKS", "NEXT"},
        both,
        {"NEXT"},
    ),
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
