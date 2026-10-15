"""
FastAPI application assembly — lifespan, error contract, and router registration.

Purpose in the project
----------------------
This replaces the stdlib ``http.server`` handler (``handler.py``) as the browser- and
agent-facing boundary. It preserves every route and JSON
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

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth, config, graph, local_auth, mcp_gateway, migrations, routes, scheduler
from .logsetup import configure_logging

log = logging.getLogger("pona_flow.app")


def _configured_bind_host() -> str | None:
    """Best-effort bind host for the startup bypass guard.

    ``dev_server.py`` and the container image export the host they bind to. A bare
    ``uvicorn`` invocation does not, so we fall back to uvicorn's own default
    (loopback) unless we can tell we are inside a container, where the listener is
    always reachable from outside the process namespace.
    """
    for key in ("PONA_FLOW_HOST", "FORM_BRIDGE_HOST"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    if os.environ.get("PONA_FLOW_DATA_DIR") or os.path.exists("/.dockerenv"):
        return "0.0.0.0"
    return "127.0.0.1"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    config.load_env_files()
    configure_logging()
    auth.assert_dev_bypass_safe(_configured_bind_host())
    migrations.run_startup_migrations()
    log.info(
        "pona flow ready: auth_mode=%s data_dir=%s catalog=%s",
        local_auth.auth_mode(),
        config.data_dir(),
        config.catalog_sqlite_path(),
    )
    if local_auth.auth_mode() == local_auth.MODE_LOCAL and local_auth.setup_required():
        log.info("No accounts yet: open the app in a browser to create the first admin.")
    if not graph.NEO4J_AVAILABLE:
        log.warning(
            "neo4j package not installed — graph checks and CREATE will fail. "
            "Run: pip install neo4j"
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
        # Forward any headers the raiser attached (WWW-Authenticate, Retry-After, ...).
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.detail},
            headers=dict(exc.headers or {}),
        )

    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        # Baseline browser hardening that is safe regardless of the reverse proxy in
        # front. CSP is deliberately not set here: the SPA loads Google Fonts and inline
        # SVG, and operators who want a strict policy should set it at the edge.
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        if request.url.scheme == "https" or (
            request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
        ):
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=15552000; includeSubDomains"
            )
        return response

    for router in routes.ALL_ROUTERS:
        app.include_router(router)

    # Mount the per-space MCP gateway (/api/spaces/{space_id}/mcp). No-op without the SDK.
    mcp_gateway.mount(app)

    return app


app = create_app()
