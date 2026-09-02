"""
Compatibility facade over the split template modules.

The former single-module implementation now lives in:

- ``templates_export`` — selection-closure resolution and template assembly
  (:func:`resolve_selection`, :func:`build_export`).
- ``templates_import`` — conflict preview, plan materialization, and the resumable
  runner (:func:`preview_import`, :func:`apply_import`, :func:`get_import_status`).

Importers (the templates API routes, tests) keep using ``templates.<name>``;
everything is re-exported here. Tests that monkeypatch *internal* call targets
(e.g. ``_fetch_query_rows``, ``_export_graph_nodes``) must patch the concrete
module, since internal calls resolve against the defining module's globals, not
this facade.
"""

from __future__ import annotations

from . import catalog  # noqa: F401  (re-exported for tests that patch module attrs)
from . import config  # noqa: F401
from . import credentials  # noqa: F401
from . import graph  # noqa: F401
from . import spaces  # noqa: F401
from .templates_export import (  # noqa: F401
    SCHEMA_VERSION,
    _blank_event_secrets,
    _cypher_traverses_downstream,
    _export_credentials,
    _export_graph_nodes,
    _export_relationships,
    _fetch_entities_by_ids,
    _fetch_query_rows,
    _formats_in_parameters,
    _labels_in_builder_config,
    _normalize_selection,
    build_export,
    resolve_selection,
)
from .templates_import import (  # noqa: F401
    _build_remaps,
    _collect_ids,
    _execute_statement,
    _materialize_plan,
    _rewrite_json,
    _rewrite_text,
    _suggest_name,
    _template_graph_labels,
    _validate_plan,
    apply_import,
    get_import_status,
    preview_import,
)
