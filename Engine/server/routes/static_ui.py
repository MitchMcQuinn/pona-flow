"""Static UI serving (public; the SPA boots before Clerk sign-in)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.exceptions import HTTPException
from fastapi.responses import FileResponse, Response

from .. import config

router = APIRouter()

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def _serve_static_file(path: str) -> Response:
    if path in ("", "/"):
        path = "/App/ui/dist/index.html"
    if not path.startswith("/App/"):
        raise HTTPException(404, "Not found")
    rel = path[len("/App/") :]
    file_path = (config.APP_DIR / rel).resolve()
    if not str(file_path).startswith(str(config.APP_DIR.resolve())):
        raise HTTPException(403, "Forbidden")
    if not file_path.is_file():
        raise HTTPException(404, "Not found")
    suffix = file_path.suffix.lower()
    content_type = _CONTENT_TYPES.get(suffix, "application/octet-stream")
    if suffix == ".html":
        cache_control = "no-cache, no-store, must-revalidate"
    elif "/ui/dist/assets/" in path:
        cache_control = "public, max-age=31536000, immutable"
    else:
        cache_control = "no-cache"
    return FileResponse(
        file_path,
        media_type=content_type,
        headers={"Cache-Control": cache_control},
    )


@router.get("/")
def root():
    return _serve_static_file("/")


@router.get("/App/{rest:path}")
def static_app(rest: str):
    return _serve_static_file(f"/App/{rest}")
