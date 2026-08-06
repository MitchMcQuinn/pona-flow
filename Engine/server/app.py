"""
FastAPI application assembly — lifespan, error contract, and router registration.

Purpose in the project
----------------------
This replaces the stdlib ``http.server`` handler (``handler.py``) as the browser- and
agent-facing boundary (see Docs/DECISIONS.md D4). It preserves every route and JSON
contract of the original server, but adds:

- **Authentication** on all ``/api/*`` routes via a verified Clerk JWT (``server.auth``).
- **Authorization**: space-scoped routes check membership; ``/api/db/*`` requires an
  instance admin.

The route handlers themselves live in domain-scoped ``APIRouter`` modules under
``server.routes`` (spaces, rbac, queries, events, graph, execution, ...), sharing the
validation/error helpers in ``server.http_utils``. Business logic is unchanged: routes
call the same domain modules (``spaces``, ``graph``, ``catalog``, ``packages``,
``execution``). TLS and CORS are handled by Cloudflare in front of the instance (D3),
so they are intentionally not configured here.

Error contract: a global handler renders ``HTTPException`` as ``{"error": <detail>}``
to match the original server (the React client reads ``data.error``).
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, graph, mcp_gateway, migrations, routes, scheduler


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    config.load_env_file(config.ROOT / ".env")
    migrations.run_startup_migrations()
    if not graph.NEO4J_AVAILABLE:
        sys.stderr.write(
            "WARNING: neo4j package not installed — graph checks and CREATE will fail. "
            "Run: pip install neo4j\n"
        )
    # Start the in-process event scheduler: recover missed timers, then fire on schedule.
    await scheduler.start()
    # Run the MCP gateway's Streamable HTTP session manager (no-op if the SDK is absent).
    async with mcp_gateway.lifespan():
        try:
            yield
        finally:
            await scheduler.stop()


def create_app() -> FastAPI:
    app = FastAPI(
        title="pona flow",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(_request: Request, exc: StarletteHTTPException):
        # Preserve the {"error": ...} contract for API clients; static 404s pass through too.
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    for router in routes.ALL_ROUTERS:
        app.include_router(router)

    # Mount the per-space MCP gateway (/api/spaces/{space_id}/mcp). No-op without the SDK.
    mcp_gateway.mount(app)

    return app


app = create_app()
