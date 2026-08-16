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

from . import catalog, embeddings, graph, spaces


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


def _assert_attributive_labels_available(
    space_id: str,
    attributive_labels: list[str] | None,
    owner_ids: list[str] | None,
) -> None:
    """Reject a create whose new attributive_labels are already owned by another entity.

    Attributive labels are globally unique across STEP and SCHEMA. The React builder
    enforces this with debounced field checks before enabling Run, but that gate lives
    entirely in the browser — any other client (the MCP authoring server, a raw API call)
    would otherwise MERGE onto an existing node and silently graft new configuration onto
    someone else's entity.

    ``owner_ids`` are the entity ids this package itself writes. A label held only by
    those is a re-save of the caller's own entity (the STEP auto-wrap does exactly this
    on every save) and is allowed; a label held by anything else is a collision.
    """
    mine = {str(i or "").strip() for i in (owner_ids or []) if str(i or "").strip()}
    seen: set[str] = set()
    for raw in attributive_labels or []:
        label = str(raw or "").strip()
        if not label or label in seen:
            continue
        seen.add(label)
        holders = graph.attributive_label_owner_ids(space_id, label)
        if holders - mine:
            raise ValueError(
                f"attributive_label {label!r} is already used by another STEP or SCHEMA "
                "in this graph. Choose a different name."
            )


def execute_create_package(
    space_id: str,
    cypher_statements: list[str],
    sqlite_statements: list[str],
    cypher_params: dict[str, Any] | None = None,
    queries_catalog: dict[str, Any] | None = None,
    attributive_labels: list[str] | None = None,
    attributive_label_owner_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Run composed Cypher (Neo4j) and SQLite statements for a space."""
    _assert_attributive_labels_available(
        space_id, attributive_labels, attributive_label_owner_ids
    )

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
    declared: list[Any] | None = None,
) -> dict[str, Any]:
    """
    Run composed Cypher (and optional SQLite mirror writes) for a read/update/delete query.

    Unlike :func:`execute_create_package`, this path never upserts the catalog and never
    registers attributive labels. ``read`` queries return Neo4j records for the caller to
    render; ``update`` / ``delete`` additionally apply SQLite ``entities`` mirror writes in
    a single transaction on the space DB.
    """
    # Vector-search Cypher needs the query text embedded before Neo4j runs; no-op for
    # ordinary MATCH…RETURN packages. ``declared`` names which parameter holds the
    # text/k when the author parameterized them (``vector_role``); reserved names
    # are the fallback for operations saved before that existed.
    resolved = embeddings.resolve_search_params(
        space_id, cypher_statements, cypher_params, declared
    )
    cypher_results = _run_cypher_list(space_id, cypher_statements, resolved)
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
