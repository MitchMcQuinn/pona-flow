#!/usr/bin/env python3
r"""
pona flow server entry point — FastAPI/ASGI app served by uvicorn.

Serves the static App/ tools (React dashboard, SQLite catalog editor) and the JSON API.
Unlike the original stdlib http.server, every /api/* route requires a verified Clerk
session token, and space-scoped routes enforce membership (see server/auth.py and
Docs/DECISIONS.md). TLS and CORS are handled by Cloudflare in front of the instance.

  python Engine/dev_server.py
  # React UI (built): http://127.0.0.1:8765/App/ui/dist/index.html
  # React UI (live):  cd App/ui && npm run dev  →  http://127.0.0.1:5173

Environment (optional):
  FORM_BRIDGE_HOST, FORM_BRIDGE_PORT — bind address (legacy names retained)
Required for auth (see .env.example):
  CLERK_JWKS_URL or CLERK_ISSUER, plus the React app's VITE_CLERK_PUBLISHABLE_KEY.
"""

from __future__ import annotations

import os

from server import config
from server.ui_build import warn_if_ui_dist_stale


def main() -> None:
    config.load_env_file(config.ROOT / ".env")
    host = os.environ.get("FORM_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("FORM_BRIDGE_PORT", "8765"))

    warn_if_ui_dist_stale(config.APP_DIR)
    print(f"React UI (built):  http://{host}:{port}/App/ui/dist/index.html", flush=True)
    print(
        "  After editing App/ui/src: cd App/ui && npm run build  (server restart is not enough)",
        flush=True,
    )
    print("React UI (live):   cd App/ui && npm run dev → http://127.0.0.1:5173", flush=True)
    print(f"SQLite editor:     http://{host}:{port}/App/data-db-editor.html", flush=True)
    print(
        f"Catalog SQLite via .env key: {config.catalog_sqlite_env_key()!r}",
        flush=True,
    )

    import uvicorn

    # Import string enables reload; app factory wiring lives in server/app.py.
    uvicorn.run("server.app:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
