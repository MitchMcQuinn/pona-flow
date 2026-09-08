"""
Join STEP: opt-in barrier on the serial walk.

A join does not park and does not run arms in parallel. When a predecessor would
enqueue a join, the walk records the arrival and holds the join off the queue
until no remaining queued step can still reach it. Untaken conditional arms are
never queued, so they cannot deadlock the barrier.

Default fan-in (a non-join step with two inbound edges) is unchanged: first
arrival runs it, later arrivals hit ``visited`` and skip.
"""

from __future__ import annotations

from typing import Any


def is_join(step: dict[str, Any] | None) -> bool:
    return str((step or {}).get("kind") or "").strip() == "join"


def can_reach(
    steps_by_id: dict[str, dict[str, Any]], start_id: str, target_id: str
) -> bool:
    """True when ``start_id`` can reach ``target_id`` by following ``next``.

    Stops at ``target_id`` rather than walking through it, so a cycle that
    includes the join does not look like a pending arm forever.
    """
    start = str(start_id or "").strip()
    target = str(target_id or "").strip()
    if not start or not target:
        return False
    if start == target:
        return True
    seen: set[str] = set()
    stack = [start]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        step = steps_by_id.get(node) or {}
        for transition in step.get("next") or []:
            nxt = str(transition.get("id") or "").strip()
            if not nxt or nxt in seen:
                continue
            if nxt == target:
                return True
            stack.append(nxt)
    return False


def record_arrival(
    join_arrivals: dict[str, list[str]], join_id: str, from_id: str
) -> None:
    arrived = join_arrivals.setdefault(join_id, [])
    source = str(from_id or "").strip()
    if source and source not in arrived:
        arrived.append(source)


def enqueue_from(
    step: dict[str, Any],
    targets: list[str],
    queue: list[str],
    steps_by_id: dict[str, dict[str, Any]],
    visited: set[str],
    join_arrivals: dict[str, list[str]],
) -> None:
    """Enqueue outgoing targets, holding join STEPs until taken arms have finished."""
    from_id = str(step.get("id") or "").strip()
    pending_joins: list[str] = []
    for target in targets:
        dest = steps_by_id.get(target)
        if dest is not None and is_join(dest):
            record_arrival(join_arrivals, target, from_id)
            pending_joins.append(target)
            continue
        queue.append(target)
    for join_id in pending_joins:
        if join_id in visited or join_id in queue:
            continue
        if _queued_arm_can_reach(queue, steps_by_id, join_id):
            continue
        queue.insert(0, join_id)
    _flush_ready_joins(queue, steps_by_id, visited, join_arrivals)


def _flush_ready_joins(
    queue: list[str],
    steps_by_id: dict[str, dict[str, Any]],
    visited: set[str],
    join_arrivals: dict[str, list[str]],
) -> None:
    """Enqueue a join that already has an arrival once no queued step can still reach it.

    Needed when an earlier arm offered the join and held, then a later queued step
    finished without targeting the join (an untaken conditional). Without this flush
    the join would stay off the queue forever.
    """
    for join_id in list(join_arrivals.keys()):
        if join_id in visited or join_id in queue:
            continue
        if not is_join(steps_by_id.get(join_id)):
            continue
        if _queued_arm_can_reach(queue, steps_by_id, join_id):
            continue
        queue.insert(0, join_id)


def _queued_arm_can_reach(
    queue: list[str],
    steps_by_id: dict[str, dict[str, Any]],
    join_id: str,
) -> bool:
    for sid in queue:
        if sid == join_id:
            continue
        if can_reach(steps_by_id, sid, join_id):
            return True
    return False


def reject_join_policy(
    steps: dict[str, dict[str, Any]], loop: dict[str, Any] | None = None
) -> None:
    """Compose-time bans: join in a loop body, nested joins, join with no inbound edge."""
    joins = [
        step
        for step in steps.values()
        if isinstance(step, dict) and is_join(step)
    ]
    if not joins:
        return

    inbound: dict[str, list[str]] = {str(sid): [] for sid in steps}
    for step_id, step in steps.items():
        for transition in step.get("next") or []:
            target = str(transition.get("id") or "").strip()
            if target in inbound:
                inbound[target].append(str(step_id))

    body = {str(sid) for sid in (loop or {}).get("body") or []}
    join_ids = {str(step.get("id") or "") for step in joins}

    for step in joins:
        join_id = str(step.get("id") or "")
        if join_id in body:
            raise ValueError(
                f"Join step {join_id!r} sits inside a loop body. A join cannot be "
                "inside a cycle — place it after the loop, or collect across passes "
                "instead."
            )
        if not inbound.get(join_id):
            raise ValueError(
                f"Join step {join_id!r} has no incoming transition in this sequence. "
                "Draw the arms into the join; the outgoing edge is the continuation."
            )

    for step in joins:
        join_id = str(step.get("id") or "")
        if _join_reaches_another_join(steps, join_id, join_ids):
            raise ValueError(
                f"Join step {join_id!r} can reach another join. Nested joins are "
                "not supported — flatten the barriers or inline the inner chain."
            )


def _join_reaches_another_join(
    steps: dict[str, dict[str, Any]],
    start_id: str,
    join_ids: set[str],
) -> bool:
    """Walk from a join's outgoing edges; stop at (do not traverse through) any join."""
    start = steps.get(start_id) or {}
    stack = [
        str(transition.get("id") or "").strip()
        for transition in start.get("next") or []
    ]
    seen: set[str] = {start_id}
    while stack:
        node = stack.pop()
        if not node or node in seen:
            continue
        seen.add(node)
        if node in join_ids:
            return True
        step = steps.get(node) or {}
        for transition in step.get("next") or []:
            nxt = str(transition.get("id") or "").strip()
            if nxt and nxt not in seen:
                stack.append(nxt)
    return False
