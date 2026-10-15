"""Detect when the React UI source tree is newer than the committed dist bundle."""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("pona_flow.ui")


def warn_if_ui_dist_stale(app_dir: Path) -> None:
    """Log a startup warning when ``App/ui/src`` changed after the last ``npm run build``."""
    src_root = app_dir / "ui" / "src"
    dist_assets = app_dir / "ui" / "dist" / "assets"
    if not src_root.is_dir():
        return
    dist_js = list(dist_assets.glob("index-*.js")) if dist_assets.is_dir() else []
    if not dist_js:
        log.warning("App/ui/dist is missing — build the React UI: cd App/ui && npm run build")
        return

    src_mtime = max(p.stat().st_mtime for p in src_root.rglob("*") if p.is_file())
    dist_mtime = max(p.stat().st_mtime for p in dist_js)
    if src_mtime > dist_mtime + 1.0:
        newest = max(src_root.rglob("*.tsx"), key=lambda p: p.stat().st_mtime, default=None)
        log.warning(
            "App/ui/src is newer than App/ui/dist — UI changes are NOT live yet. "
            "Run: cd App/ui && npm run build%s",
            f" (newest source: {newest.relative_to(app_dir)})" if newest else "",
        )
