#!/usr/bin/env python3
"""
Sandbox runner entry point — run as a SEPARATE process from the main app.

  python Engine/runner/dev_runner.py
  # binds 127.0.0.1:8766 by default (PONA_FLOW_RUNNER_HOST / PONA_FLOW_RUNNER_PORT)

Requires Docker and the prebuilt sandbox images:

  Engine/runner/images/build.sh

In production run this under a dedicated unprivileged OS user that is in the docker
group (or talks to a socket proxy) — the main app's user must NOT have Docker access.
Set PONA_FLOW_RUNNER_TOKEN to a strong shared secret and mirror it in the main app's
environment.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Allow `python Engine/runner/dev_runner.py` from the repo root (mirrors dev_server.py).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner.runner import app  # noqa: E402  (import after sys.path tweak)


def _load_env_file(path: Path) -> None:
    """Minimal .env loader (setdefault) so the runner shares the project's secrets."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def main() -> None:
    _load_env_file(Path(__file__).resolve().parent.parent.parent / ".env")
    host = os.environ.get("PONA_FLOW_RUNNER_HOST", "127.0.0.1")
    port = int(os.environ.get("PONA_FLOW_RUNNER_PORT", "8766"))
    if not (os.environ.get("PONA_FLOW_RUNNER_TOKEN") or "").strip():
        print(
            "WARNING: PONA_FLOW_RUNNER_TOKEN is not set — set a shared secret in production.",
            flush=True,
        )
    print(f"Sandbox runner: http://{host}:{port} (health: /healthz)", flush=True)

    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
