"""
Compatibility facade over the split execution modules.

The former single-module implementation now lives in:

- ``execution_compose`` — walks a sequence's STEP chain and builds/persists the
  EXECUTION package (:func:`compose_execution_package`, :func:`compose_and_store`,
  :func:`enumerate_sequence_operation_ids`).
- ``execution_run`` — the resumable executor (:func:`run_execution`) and the
  per-step-kind runners (query / endpoint / local LLM).
- ``execution_loop`` — sequence loop policy: config normalization, back-edge
  detection, and the guard comparisons shared by the composer and the executor.

Importers (``sequence_service``, ``scheduler``, ``schema_suspension``, the API
routes, tests) keep using ``execution.<name>``; everything is re-exported here.
Tests that monkeypatch *internal* call targets (e.g. ``_execute_step``)
must patch the concrete module, since internal calls resolve against the
defining module's globals, not this facade.
"""

from __future__ import annotations

from . import catalog  # noqa: F401  (re-exported for tests that patch module attrs)
from . import config  # noqa: F401
from . import credentials  # noqa: F401
from . import execution_loop  # noqa: F401
from . import graph  # noqa: F401
from . import spaces  # noqa: F401
from .execution_compose import (  # noqa: F401
    _alias_source_steps,
    _build_step,
    _load_step_adjacency,
    _load_step_entities,
    _loop_referenceable_names,
    _parse_initial_step_label,
    _step_return_aliases,
    _to_step_parameters,
    compose_and_store,
    compose_execution_package,
    enumerate_sequence_operation_ids,
)
from .execution_loop import (  # noqa: F401
    analyze_loop,
    cycle_body,
    find_back_edges,
    normalize_loop_config,
    validate_loop_config,
)
from .execution_run import (  # noqa: F401
    _bind_loop_item,
    _bind_query_return_columns,
    _bind_response_parameters,
    _capture_loop_items,
    _classify_final_response,
    _clear_iteration_state,
    _coerce_bool,
    _coerce_declared_boolean_params,
    _execute_code_step,
    _execute_endpoint_step,
    _execute_query_step,
    _execute_step,
    _extract_path,
    _loop_exit_targets,
    _mint_auto_ids,
    _new_loop_state,
    _passing_targets,
    _progress_snapshot,
    _resolve_secrets,
    _should_continue_loop,
    _should_enter_loop_body,
    _substitute,
    _truthy,
    _validate_outbound_url,
    run_execution,
)
