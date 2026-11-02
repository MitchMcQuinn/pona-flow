"""Download the catalog and local graph for an instance admin."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.exceptions import HTTPException
from fastapi.responses import Response

from .. import auth, config, instance_export
from ..auth import Principal

router = APIRouter()


@router.get("/api/instance/export")
def export_instance(_principal: Principal = Depends(auth.require_instance_admin)) -> Response:
    uri = (os.environ.get("NEO4J_URI") or "").strip()
    data_dir = Path(os.environ.get("PONA_FLOW_DATA_DIR") or config.data_dir())
    neo4j_data = data_dir / "neo4j" / "data"
    try:
        payload = instance_export.build_export(
            config.catalog_sqlite_path(),
            uri,
            neo4j_data if neo4j_data.is_dir() else None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(
        content=payload,
        media_type="application/gzip",
        headers={"Content-Disposition": 'attachment; filename="pona-flow-export.tar.gz"'},
    )
