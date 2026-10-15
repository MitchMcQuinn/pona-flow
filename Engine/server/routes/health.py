"""Liveness/readiness probe for container orchestrators and reverse proxies.

``GET /healthz`` is unauthenticated and cheap: it confirms the process is serving and the
catalog SQLite file is reachable. ``GET /healthz?deep=1`` additionally opens a Neo4j
session with the instance-wide ``NEO4J_*`` credentials, which is what a self-hoster wants
to know on first boot ("is my database wired up?") but is too expensive for a
once-a-second liveness check. The body never includes connection strings or secrets.
"""

from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .. import config, graph, local_auth

log = logging.getLogger("pona_flow.health")

router = APIRouter()


def _catalog_ok() -> tuple[bool, str | None]:
    try:
        conn = config.connect_sqlite(config.catalog_sqlite_path())
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return True, None
    except (sqlite3.Error, OSError, KeyError) as e:
        log.warning("healthz: catalog check failed: %s", e)
        return False, "catalog database unavailable"


def _neo4j_ok() -> tuple[bool, str | None]:
    if not graph.NEO4J_AVAILABLE:
        return False, "neo4j driver not installed"
    try:
        uri = config.env_value("NEO4J_URI")
        user = config.env_value("NEO4J_USER")
        password = config.env_value("NEO4J_PASSWORD")
    except KeyError:
        return False, "NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD not configured"
    try:
        from neo4j import GraphDatabase

        driver = GraphDatabase.driver(graph.direct_bolt_uri(uri), auth=(user, password))
        try:
            driver.verify_connectivity()
        finally:
            driver.close()
        return True, None
    except Exception as e:  # driver raises many types; never leak details to the client
        log.warning("healthz: neo4j check failed: %s", e)
        return False, "neo4j unreachable or credentials rejected"


@router.get("/healthz")
def healthz(deep: int = Query(0)):
    checks: dict[str, dict[str, object]] = {}
    ok, detail = _catalog_ok()
    checks["catalog"] = {"ok": ok, **({"detail": detail} if detail else {})}
    if deep:
        ok_neo, detail_neo = _neo4j_ok()
        checks["neo4j"] = {"ok": ok_neo, **({"detail": detail_neo} if detail_neo else {})}
    healthy = all(bool(c["ok"]) for c in checks.values())
    body = {
        "status": "ok" if healthy else "degraded",
        "auth_mode": local_auth.auth_mode(),
        "checks": checks,
    }
    return JSONResponse(body, status_code=200 if healthy else 503)
