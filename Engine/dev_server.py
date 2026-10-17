#!/usr/bin/env python3
r"""
pona flow development entry point — runs the FastAPI/ASGI app under uvicorn.

This is the convenient way to start the server from a source checkout: it loads ``.env``,
prints where the UI is, and runs uvicorn with sensible local defaults. Production deploys
(the container image, systemd) run uvicorn directly against the same app:

  uvicorn server.app:app --host 0.0.0.0 --port 8765 --app-dir Engine

Routes under /api/* require a signed-in principal (built-in accounts by default, Clerk
optionally — see Docs/DEPLOYMENT.md and server/auth.py). Static files (the built React UI
at ``/`` and the catalog editor) are served from App/.

  python Engine/dev_server.py
  # React UI (built):  http://127.0.0.1:8765/
  # React UI (live):   cd App/ui && npm run dev  →  http://127.0.0.1:5273

Environment (optional):
  PONA_FLOW_HOST / PONA_FLOW_PORT — bind address (default 127.0.0.1:8765; the legacy
  FORM_BRIDGE_HOST / FORM_BRIDGE_PORT names are still honoured).
"""

from __future__ import annotations

import os

from server import config
from server.logsetup import configure_logging
from server.ui_build import warn_if_ui_dist_stale


def main() -> None:
    config.load_env_files()
    configure_logging()
    host = os.environ.get("PONA_FLOW_HOST") or os.environ.get("FORM_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("PONA_FLOW_PORT") or os.environ.get("FORM_BRIDGE_PORT", "8765"))
    # Let the app's startup guard see the bind address (see server.app._configured_bind_host).
    os.environ["PONA_FLOW_HOST"] = host

    warn_if_ui_dist_stale(config.APP_DIR)
    print(f"pona flow:         http://{host}:{port}/", flush=True)
    print("React UI (live):   cd App/ui && npm run dev → http://127.0.0.1:5273", flush=True)
    print(
        "  After editing App/ui/src: cd App/ui && npm run build  (server restart is not enough)",
        flush=True,
    )
    print(f"SQLite editor:     http://{host}:{port}/App/data-db-editor.html", flush=True)
    print(f"Data directory:    {config.data_dir()}", flush=True)

    import uvicorn

    # Import string enables reload; app factory wiring lives in server/app.py.
    uvicorn.run("server.app:app", host=host, port=port, log_level="info", proxy_headers=True)


if __name__ == "__main__":
    main()
