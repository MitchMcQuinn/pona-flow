"""
API route modules — one ``APIRouter`` per domain area, assembled by ``server.app``.

``ALL_ROUTERS`` preserves the registration order of the original monolithic app so
overlapping path patterns keep their historical matching precedence.
"""

from __future__ import annotations

from . import (
    agent_keys,
    credentials,
    db_editor,
    embeddings,
    events,
    execution,
    graph,
    local_llms,
    principal,
    queries,
    rbac,
    regex,
    schema_ops,
    spaces,
    static_ui,
    templates,
    webhooks,
)

ALL_ROUTERS = (
    principal.router,
    spaces.router,
    rbac.router,
    queries.router,
    events.router,
    graph.router,
    schema_ops.router,
    execution.router,
    webhooks.router,
    agent_keys.router,
    credentials.router,
    templates.router,
    embeddings.router,
    local_llms.router,
    regex.router,
    db_editor.router,
    static_ui.router,
)
