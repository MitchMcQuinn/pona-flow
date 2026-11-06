"""Browser tab title and icon for this instance.

The title is the Fly app name. The icon is a rainbow wave unless an instance admin
has stored a short label, which is drawn in that same gradient instead.
"""

from __future__ import annotations

import os
import threading
from html import escape
from pathlib import Path

from . import config

MAX_ICON_LABEL = 8
_LABEL_NAME = "tab-icon-label"
_lock = threading.Lock()

def _gradient(*, across_icon: bool) -> str:
    if across_icon:
        box = 'x1="2" y1="16" x2="30" y2="16" gradientUnits="userSpaceOnUse"'
    else:
        box = 'x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox"'
    return (
        f"<linearGradient id=\"g\" {box}>"
        '<stop offset="0" stop-color="#6366f1"/>'
        '<stop offset="0.34" stop-color="#8b5cf6"/>'
        '<stop offset="0.67" stop-color="#d946ef"/>'
        '<stop offset="1" stop-color="#06b6d4"/>'
        "</linearGradient>"
    )


def app_name() -> str:
    """The Fly app name, when this process is an instance that has one."""
    return (os.environ.get("FLY_APP_NAME") or os.environ.get("FLY_APP") or "").strip()


def tab_title() -> str:
    return app_name() or "pona flow"


def public_chrome() -> dict[str, str]:
    return {"app_name": app_name(), "icon_label": icon_label()}


def icon_label() -> str:
    path = _label_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    return _normalize(raw) if _fits(raw) else ""


def set_icon_label(value: str) -> str:
    """Persist a label, or clear it when ``value`` is blank. Raises ValueError."""
    if not isinstance(value, str):
        raise ValueError("icon label must be text")
    cleaned = _normalize(value)
    if cleaned and not _fits(value):
        raise ValueError(f"Use {MAX_ICON_LABEL} characters or fewer.")
    if any(ord(ch) < 32 for ch in cleaned):
        raise ValueError("That label cannot include control characters.")
    path = _label_path()
    with _lock:
        if not cleaned:
            path.unlink(missing_ok=True)
            return ""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.tmp")
        tmp.write_text(cleaned, encoding="utf-8")
        tmp.replace(path)
    return cleaned


def clear_icon_label() -> None:
    set_icon_label("")


def icon_svg() -> str:
    label = icon_label()
    if label:
        return _label_svg(label)
    return _wave_svg()


def with_tab_title(html: str) -> str:
    """Replace the document title in a served ``index.html``."""
    title = escape(tab_title())
    start = html.lower().find("<title>")
    end = html.lower().find("</title>")
    if start < 0 or end < start:
        return html
    return html[:start] + f"<title>{title}</title>" + html[end + len("</title>") :]


def _label_path() -> Path:
    return config.data_dir() / _LABEL_NAME


def _normalize(value: str) -> str:
    return " ".join(value.split())


def _fits(value: str) -> bool:
    return len(_normalize(value)) <= MAX_ICON_LABEL


def _font_size(label: str) -> int:
    n = len(label)
    if n <= 1:
        return 18
    if n == 2:
        return 14
    if n <= 4:
        return 10
    return 7


def _wave_svg() -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f"<defs>{_gradient(across_icon=True)}</defs>"
        '<path d="M3 18C8 9 12 9 16 18S24 27 29 18" fill="none" '
        'stroke="url(#g)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>'
        "</svg>"
    )


def _label_svg(label: str) -> str:
    text = escape(label)
    size = _font_size(label)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f"<defs>{_gradient(across_icon=False)}</defs>"
        '<rect width="32" height="32" rx="7" fill="#14141a"/>'
        f'<text x="16" y="17" text-anchor="middle" dominant-baseline="central" '
        f'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" '
        f'font-weight="700" font-size="{size}" fill="url(#g)">{text}</text>'
        "</svg>"
    )
