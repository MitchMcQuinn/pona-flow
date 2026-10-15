"""Process-wide logging bootstrap shared by the ASGI app and the CLI tools."""

from __future__ import annotations

import logging
import os
import sys


def configure_logging() -> None:
    """Route the app's ``pona_flow.*`` loggers to stderr unless the host already did.

    ``PONA_FLOW_LOG_LEVEL`` (default INFO). uvicorn configures its own loggers; this only
    adds a handler to the root when nothing else has, so embedding under another process
    manager keeps that manager's configuration.
    """
    level_name = (os.environ.get("PONA_FLOW_LOG_LEVEL") or "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=level,
            stream=sys.stderr,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
    logging.getLogger("pona_flow").setLevel(level)
