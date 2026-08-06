"""
QUERY / CRUD package execution — apply composed Cypher and SQLite for a space.

Purpose in the project
----------------------
When the React QUERY builder executes a create package, the browser sends
``POST /api/execute-create`` with:

- ``space_id`` — which environment to target
- ``cypher`` — list of Cypher strings to run on Neo4j
- ``sqlite`` — list of SQL strings to run on the space's SQLite file
- ``cypher_params`` — optional parameter map for all Cypher statements
- ``queries_catalog`` — optional metadata to upsert into catalog ``queries`` table

This module orchestrates those steps in order: optional catalog upsert, then each
Cypher statement, then each SQLite statement in one transaction on the space DB.

Importance
----------
This is the **write path** for the QUERY builder—distinct from read-only graph checks
in ``graph`` and catalog editing in ``catalog``. Keeping it separate clarifies that
package execution touches three stores (catalog + Neo4j + per-space SQLite) in one API call.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from . import catalog, graph, spaces


def _run_cypher_list(
    space_id: str, statements: list[str], params: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Run each non-empty Cypher statement against the space's Neo4j db, in order."""
    results = []
    for stmt in statements:
        text = (stmt or "").strip()
        if not text:
            continue
        results.append(graph.run_cypher_for_space(space_id, text, params or {}))
    return results


def _run_sqlite_list(
    space_id: str, statements: list[str], *, enrich_errors: bool
) -> list[dict[str, Any]]:
    """Run SQLite statements in one transaction on the space DB (rollback on error).

    ``enrich_errors`` appends the failing statement text to the raised error (used by
    the create path, where composed statements are user-authored).
    """
    results: list[dict[str, Any]] = []
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        for stmt in statements:
            text = (stmt or "").strip()
            if not text:
                continue
            if enrich_errors:
                try:
                    cur = conn.execute(text)
                except sqlite3.Error as e:
                    raise sqlite3.Error(f"{e} [statement: {text[:240]}]") from e
            else:
                cur = conn.execute(text)
            results.append({"rowcount": cur.rowcount, "lastrowid": cur.lastrowid})
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise
    finally:
        conn.close()
    return results


def execute_create_package(
    space_id: str,
    cypher_statements: list[str],
    sqlite_statements: list[str],
    cypher_params: dict[str, Any] | None = None,
    queries_catalog: dict[str, Any] | None = None,
    attributive_labels: list[str] | None = None,
) -> dict[str, Any]:
    """Run composed Cypher (Neo4j) and SQLite statements for a space."""
    catalog_result = None
    if queries_catalog:
        catalog_result = catalog.upsert_queries_catalog_row(
            str(queries_catalog.get("id") or ""),
            str(queries_catalog.get("name") or ""),
            list(queries_catalog.get("cypher") or []),
            list(queries_catalog.get("sqlite") or []),
            list(queries_catalog.get("parameters") or []),
            str(queries_catalog.get("kind") or "user"),
            str(queries_catalog.get("operation") or "read"),
            catalog.queries_catalog_runtime_enabled_int(queries_catalog),
            catalog.queries_catalog_author_selectable_int(queries_catalog),
        )

    cypher_results = _run_cypher_list(space_id, cypher_statements, cypher_params)
    sqlite_results = _run_sqlite_list(space_id, sqlite_statements, enrich_errors=True)

    out: dict[str, Any] = {"cypher": cypher_results, "sqlite": sqlite_results}
    if catalog_result is not None:
        out["queries_catalog"] = catalog_result

    if attributive_labels:
        out["space_labels"] = spaces.append_space_attributive_labels(
            space_id, attributive_labels
        )

    return out


def execute_mutation_package(
    space_id: str,
    cypher_statements: list[str],
    sqlite_statements: list[str],
    cypher_params: dict[str, Any] | None = None,
    operation: str = "read",
) -> dict[str, Any]:
    """
    Run composed Cypher (and optional SQLite mirror writes) for a read/update/delete query.

    Unlike :func:`execute_create_package`, this path never upserts the catalog and never
    registers attributive labels. ``read`` queries return Neo4j records for the caller to
    render; ``update`` / ``delete`` additionally apply SQLite ``entities`` mirror writes in
    a single transaction on the space DB.
    """
    cypher_results = _run_cypher_list(space_id, cypher_statements, cypher_params)
    sqlite_results: list[dict[str, Any]] = []
    if sqlite_statements:
        sqlite_results = _run_sqlite_list(
            space_id, sqlite_statements, enrich_errors=False
        )

    return {
        "operation": operation,
        "cypher": cypher_results,
        "sqlite": sqlite_results,
    }
