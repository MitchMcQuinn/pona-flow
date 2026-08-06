"""
Transport-agnostic sequence execution service.

Purpose in the project
----------------------
This module is the shared seam between the inbound HTTP webhook (this phase) and the
per-space MCP server (next phase). Both transports call the same two primitives, so the
run semantics — including the human-in-the-loop pause that returns required parameters —
live in exactly one place:

- ``run_sequence_once`` composes + runs a sequence in a single call (or resumes a paused
  run when given a ``state_id``), returning the executor's pending/inactive/error dict.
- ``list_runnable_sequences`` enumerates the triggerable sequences in a space with their
  aggregated parameter schema, which becomes an MCP tool's ``inputSchema`` later.

It deliberately wraps ``execution`` rather than reimplementing it: the executor remains
the single source of truth for the resumable state machine.
"""

from __future__ import annotations

import sys
from typing import Any

from . import catalog, execution


def run_sequence_once(
    space_id: str,
    sequence_id: str,
    params: dict[str, Any] | None = None,
    state_id: str | None = None,
    owner_id: str | None = None,
    trigger: str = "webhook",
    principal_id: str | None = None,
) -> dict[str, Any]:
    """
    Compose-and-run a sequence in one call, or resume a paused run.

    When ``state_id`` is omitted, the sequence is composed into a fresh EXECUTION
    package and run from the start. When ``state_id`` is supplied, the existing
    (paused) package is resumed with the new ``params`` — this is how a caller answers
    the required parameters returned by an earlier ``pending`` response.

    Returns the executor result dict verbatim, always carrying ``state_id`` so the
    caller can resume:
      - ``{"status": "pending", "state_id", "step_id", "parameters": [...], ...}``
      - ``{"status": "inactive", "state_id", "resolved", "executed", "final_result"}``
      - ``{"status": "error", "message": ...}``
    """
    sid = (space_id or "").strip()
    seq_id = (sequence_id or "").strip()
    resume_state = (state_id or "").strip()
    run_params = dict(params or {})

    if resume_state:
        return execution.run_execution(
            sid, resume_state, run_params, trigger=trigger, principal_id=principal_id
        )

    composed = execution.compose_and_store(sid, seq_id, owner_id=owner_id)
    new_state_id = str(composed.get("state_id") or "")
    if not new_state_id:
        return {"status": "error", "message": "failed to compose sequence"}
    return execution.run_execution(
        sid, new_state_id, run_params, trigger=trigger, principal_id=principal_id
    )


def list_runnable_sequences(space_id: str) -> list[dict[str, Any]]:
    """
    Enumerate the triggerable sequences in a space with an aggregated parameter schema.

    Listing uses catalog flags only (``kind == 'sequence'`` and ``runtime_enabled`` /
    ``triggerable``); parameter aggregation is best-effort: it composes each sequence's
    EXECUTION package and unions the parameters across its steps, dropping any satisfied
    by an upstream step response. A sequence whose graph can't be composed is still
    listed with an empty parameter list. This shape maps onto an MCP tool's
    ``inputSchema`` in the next phase.
    """
    sid = (space_id or "").strip()
    sequences: list[dict[str, Any]] = []
    for q in catalog.fetch_saved_queries():
        if q.get("kind") != "sequence" or not int(q.get("runtime_enabled") or 0):
            continue
        if int(q.get("suspended") or 0):
            continue
        seq_id = str(q.get("id") or "")
        detail = catalog.fetch_query_for_compose(seq_id) or {}
        if not int(detail.get("triggerable", 1)):
            continue
        sequences.append(
            {
                "id": seq_id,
                "name": q.get("name"),
                "group_title": q.get("group_title"),
                "description": str(q.get("description") or ""),
                "parameters": _aggregate_parameters(sid, seq_id),
            }
        )
    return sequences


def _aggregate_parameters(space_id: str, sequence_id: str) -> list[dict[str, Any]]:
    """Union of caller-supplied parameters across a sequence's steps (best-effort)."""
    try:
        package = execution.compose_execution_package(space_id, sequence_id)
    except Exception as err:  # compose/graph failures must not break discovery
        sys.stderr.write(f"sequence-params error ({sequence_id}): {err}\n")
        return []
    response_names = {
        str(rp.get("parameter") or "").strip()
        for rp in (package.get("response_parameters") or [])
        if isinstance(rp, dict)
    }
    seen: set[str] = set()
    params: list[dict[str, Any]] = []
    for step in package.get("steps") or []:
        for p in step.get("parameters") or []:
            if not isinstance(p, dict):
                continue
            # auto_generate parameters (create-INSTANCE graph ids) are minted by the
            # executor per run and are never caller-supplied inputs.
            if p.get("auto_generate"):
                continue
            name = str(p.get("name") or "").strip()
            if not name or name in seen or name in response_names:
                continue
            seen.add(name)
            params.append(p)
    return params
