"""
Diagnostic test for hybrid operation rename (workspace title vs wrap STEP label).

Mirrors ``shouldRetargetOperationWrap`` in App/authoring/src/uniqueAttributiveLabel.ts.
The catalog name always saves. The wrap STEP follows only when the name is free *and*
no multi-step sequence MATCHES the current wrap label.

Run: `python tests/operation-rename-hybrid.py` from the repo root.
"""

from __future__ import annotations

import sys

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


def should_retarget_sequence_wrap(
    requested_name: str,
    wrap_entity_id: str,
    current_wrap_label: str,
    label_taken_by_other: bool,
) -> bool:
    name = (requested_name or "").strip()
    if not name or not (wrap_entity_id or "").strip():
        return False
    if name == (current_wrap_label or "").strip():
        return False
    return not label_taken_by_other


def should_retarget_operation_wrap(
    requested_name: str,
    wrap_entity_id: str,
    current_wrap_label: str,
    label_taken_by_other: bool,
    multi_step_references_wrap: bool,
) -> bool:
    """Keep this in lockstep with authoring ``shouldRetargetOperationWrap``."""
    if multi_step_references_wrap:
        return False
    return should_retarget_sequence_wrap(
        requested_name, wrap_entity_id, current_wrap_label, label_taken_by_other
    )


check(
    "free name with no multi-step MATCH retargets the wrap",
    should_retarget_operation_wrap("READ_PEOPLE", "wrap-1", "READ_PERSON", False, False) is True,
)
check(
    "name taken by another STEP/SCHEMA keeps the wrap",
    should_retarget_operation_wrap("PERSON", "wrap-1", "READ_PERSON", True, False) is False,
)
check(
    "multi-step MATCH keeps the wrap even when the name is free",
    should_retarget_operation_wrap("READ_PEOPLE", "wrap-1", "READ_PERSON", False, True) is False,
)
check(
    "unchanged title is a no-op",
    should_retarget_operation_wrap("READ_PERSON", "wrap-1", "READ_PERSON", False, False) is False,
)
check(
    "no wrap STEP never retargets",
    should_retarget_operation_wrap("READ_PEOPLE", "", "READ_PERSON", False, False) is False,
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
