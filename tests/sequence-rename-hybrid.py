"""
Diagnostic test for hybrid sequence rename (workspace title vs wrap STEP label).

Mirrors ``shouldRetargetSequenceWrap`` in App/authoring/src/uniqueAttributiveLabel.ts.
The catalog name is always the workspace title. The wrapping STEP attributive_label
follows that title only when a wrap exists, the title actually changed, and no other
graph entity already holds the label.

Run: `python tests/sequence-rename-hybrid.py` from the repo root.
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
    """Keep this in lockstep with authoring ``shouldRetargetSequenceWrap``."""
    name = (requested_name or "").strip()
    if not name or not (wrap_entity_id or "").strip():
        return False
    if name == (current_wrap_label or "").strip():
        return False
    return not label_taken_by_other


check(
    "no wrap STEP (auto-wrap one-step sequence) never retargets",
    should_retarget_sequence_wrap("New Title", "", "Onboard", False) is False,
)
check(
    "blank title never retargets",
    should_retarget_sequence_wrap("  ", "wrap-1", "Onboard", False) is False,
)
check(
    "unchanged title is a no-op",
    should_retarget_sequence_wrap("Onboard", "wrap-1", "Onboard", False) is False,
)
check(
    "free name retargets the wrap",
    should_retarget_sequence_wrap("Onboard Customer", "wrap-1", "Onboard", False) is True,
)
check(
    "name taken by another STEP/SCHEMA keeps the wrap",
    should_retarget_sequence_wrap("READ_PERSON", "wrap-1", "Onboard", True) is False,
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
