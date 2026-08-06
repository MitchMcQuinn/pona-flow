"""
Compatibility facade over the split execution modules.

The former single-module implementation now lives in:

- ``execution_compose`` — walks a sequence's STEP chain and builds/persists the
  EXECUTION package (:func:`compose_execution_package`, :func:`compose_and_store`,
  :func:`enumerate_sequence_operation_ids`).
- ``execution_run`` — the resumable executor (:func:`run_execution`) and the
  per-step-kind runners (query / endpoint / sandboxed code).

Importers (``sequence_service``, ``scheduler``, ``schema_suspension``, the API
routes, tests) keep using ``execution.<name>``; everything is re-exported here.
Tests that monkeypatch *internal* call targets (e.g. ``_execute_step``,
``_call_runner``) must patch the concrete module, since internal calls resolve
against the defining module's globals, not this facade.
"""

from __future__ import annotations

from . import catalog  # noqa: F401  (re-exported for tests that patch module attrs)
from . import config  # noqa: F401
from . import credentials  # noqa: F401
from . import graph  # noqa: F401
from . import resources  # noqa: F401
from . import spaces  # noqa: F401
from .execution_compose import (  # noqa: F401
    _build_step,
    _load_step_adjacency,
    _load_step_entities,
    _parse_initial_step_label,
    _to_step_parameters,
    compose_and_store,
    compose_execution_package,
    enumerate_sequence_operation_ids,
)
from .execution_run import (  # noqa: F401
    _bind_response_parameters,
    _call_runner,
    _classify_final_response,
    _coerce_bool,
    _coerce_declared_boolean_params,
    _encode_code_literal,
    _execute_code_step,
    _execute_endpoint_step,
    _execute_query_step,
    _execute_step,
    _extract_path,
    _resolve_secrets,
    _sanitize_code_error,
    _substitute,
    _substitute_code_params,
    _truthy,
    _validate_json_shape,
    _validate_outbound_url,
    run_execution,
)
