"""
Space template import — conflict preview, plan materialization, and the runner.

Import is conflict-aware and idempotent:

- Every graph/entity/query/event id is regenerated on import, so re-importing a template
  never collides with the source's ids. Only human-facing names that would clash with the
  target (``attributive_label``, ``regex`` name, sequence name) are surfaced to the user to
  rename via :func:`preview_import`.
- :func:`apply_import` materializes a single ordered plan of MERGE/upsert statements (with
  the fresh ids and name remaps already baked in), persists it in the catalog
  ``template_imports`` row keyed by the template id, validates the whole plan against the
  current graph, then executes statement-by-statement recording progress. Because the plan's
  ids are fixed once persisted and every statement is an idempotent MERGE/upsert, an
  interrupted import can be resumed (or simply re-run) without creating duplicates.

The runner only ever writes through ``graph.run_cypher_for_space`` (the same path used by
package execution) and the catalog/per-space SQLite writers — it never opens an ad-hoc
connection to bypass those layers.

The export half lives in ``templates_export``; ``templates`` re-exports both.
"""

from __future__ import annotations

import json
import re
from typing import Any

from . import catalog, config, credentials, graph, spaces

# ID_<32 hex> — the project entity id format (see server.id_generator).
_ID_RE = re.compile(r"ID_[0-9a-f]{32}")


# --------------------------------------------------------------------------- #
# template_imports catalog row helpers
# --------------------------------------------------------------------------- #

_TEMPLATE_IMPORTS_DDL = (
    config.ROOT / "Engine" / "schema" / "template-imports-table.sql"
)


def _ensure_template_imports_table(conn) -> None:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'template_imports'"
    )
    if cur.fetchone() is None and _TEMPLATE_IMPORTS_DDL.is_file():
        conn.executescript(_TEMPLATE_IMPORTS_DDL.read_text(encoding="utf-8"))
        conn.commit()


def _load_import_row(template_id: str) -> dict[str, Any] | None:
    tid = (template_id or "").strip()
    if not tid:
        return None
    with catalog.catalog_connection() as conn:
        _ensure_template_imports_table(conn)
        cur = conn.execute(
            "SELECT id, space_id, status, plan, progress, error, creation_date, modified_date "
            "FROM template_imports WHERE id = ?",
            (tid,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "space_id": row[1],
            "status": row[2],
            "plan": json.loads(row[3] or "{}"),
            "progress": json.loads(row[4] or "{}"),
            "error": row[5],
            "creation_date": row[6],
            "modified_date": row[7],
        }


def _save_import_row(
    template_id: str,
    space_id: str,
    *,
    status: str,
    plan: dict[str, Any] | None = None,
    progress: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    with catalog.catalog_connection() as conn:
        _ensure_template_imports_table(conn)
        plan_json = json.dumps(plan if plan is not None else {})
        progress_json = json.dumps(progress if progress is not None else {})
        conn.execute(
            """
            INSERT INTO template_imports (id, space_id, status, plan, progress, error,
              creation_date, modified_date)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              space_id = excluded.space_id,
              status = excluded.status,
              plan = excluded.plan,
              progress = excluded.progress,
              error = excluded.error,
              modified_date = datetime('now')
            """,
            (template_id, space_id, status, plan_json, progress_json, error),
        )
        conn.commit()


def _update_import_progress(
    template_id: str, *, status: str, progress: dict[str, Any], error: str | None = None
) -> None:
    with catalog.catalog_connection() as conn:
        _ensure_template_imports_table(conn)
        conn.execute(
            "UPDATE template_imports SET status = ?, progress = ?, error = ?, "
            "modified_date = datetime('now') WHERE id = ?",
            (status, json.dumps(progress), error, template_id),
        )
        conn.commit()


# --------------------------------------------------------------------------- #
# Conflict detection (preview)
# --------------------------------------------------------------------------- #


def _template_graph_labels(template: dict[str, Any]) -> list[tuple[str, str]]:
    """``(scope, attributive_label)`` for every uniquely-named graph element in a template."""
    g = template.get("graph") or {}
    seen: set[str] = set()
    out: list[tuple[str, str]] = []

    def add(scope: str, label: str) -> None:
        label = (label or "").strip()
        if label and label not in seen:
            seen.add(label)
            out.append((scope, label))

    for node in g.get("schema_nodes") or []:
        add("schema", node.get("attributive_label") or "")
    for node in g.get("step_nodes") or []:
        add("step", node.get("attributive_label") or "")
    for rel in g.get("relationships") or []:
        add("relationship", rel.get("attributive_label") or "")
    return out


def _suggest_name(original: str, taken: set[str]) -> str:
    base = original or "imported"
    i = 2
    candidate = f"{base}_{i}"
    while candidate in taken:
        i += 1
        candidate = f"{base}_{i}"
    taken.add(candidate)
    return candidate


def preview_import(space_id: str, template: dict[str, Any]) -> dict[str, Any]:
    """Detect name collisions between *template* and the target space's current state.

    Returns the conflicts the operator must resolve (graph ``attributive_label``s,
    ``regex`` names, and sequence names) with a suggested non-colliding rename each.
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not isinstance(template, dict):
        raise ValueError("template must be a JSON object")

    conflicts: list[dict[str, Any]] = []
    taken: set[str] = set()

    # Graph attributive_label collisions (STEP/SCHEMA nodes and POINTS_TO rels share a
    # single namespace, enforced by graph.attributive_label_exists).
    for scope, label in _template_graph_labels(template):
        if graph.attributive_label_exists(sid, scope.upper(), label):
            taken.add(label)
            conflicts.append(
                {
                    "id": f"graph_label:{label}",
                    "kind": "graph_label",
                    "scope": scope,
                    "original_name": label,
                    "suggested_name": _suggest_name(label, taken),
                }
            )

    # regex names (instance-global primary key).
    existing_regex = {r["name"] for r in catalog.list_regex_patterns()}
    for pattern in (template.get("sqlite") or {}).get("regex") or []:
        name = (pattern.get("name") or "").strip()
        if name and name in existing_regex:
            taken.add(name)
            conflicts.append(
                {
                    "id": f"regex:{name}",
                    "kind": "regex",
                    "scope": "regex",
                    "original_name": name,
                    "suggested_name": _suggest_name(name, taken),
                }
            )

    # Sequence names (on create a sequence name becomes its wrapping STEP attributive_label,
    # so it must be unique within the graph cohort).
    seen_seq: set[str] = set()
    for query in (template.get("sqlite") or {}).get("queries") or []:
        if (query.get("kind") or "") != "sequence":
            continue
        name = (query.get("name") or "").strip()
        if not name or name in seen_seq:
            continue
        seen_seq.add(name)
        if spaces.sequence_name_conflict(sid, name):
            taken.add(name)
            conflicts.append(
                {
                    "id": f"sequence_name:{name}",
                    "kind": "sequence_name",
                    "scope": "query",
                    "original_name": name,
                    "suggested_name": _suggest_name(name, taken),
                }
            )

    # Credential slots the operator must populate after import (informational; no rename).
    # Resources carry fresh ids so never conflict; credentials are stable name slots.
    configured: dict[str, bool] = {}
    for cred in credentials.list_credentials(sid):
        cname = cred.get("name") or ""
        configured[cname] = bool(cred.get("configured"))
        configured[credentials.normalize_credential_name(cname)] = bool(cred.get("configured"))
    credentials_needed: list[dict[str, Any]] = []
    seen_cred: set[str] = set()
    for cred in template.get("credentials") or []:
        name = (cred.get("name") or "").strip()
        if not name or name in seen_cred:
            continue
        seen_cred.add(name)
        norm = credentials.normalize_credential_name(name)
        already = configured.get(name) or configured.get(norm) or False
        credentials_needed.append(
            {
                "name": name,
                "description": cred.get("description") or "",
                "configured": bool(already),
            }
        )

    return {
        "template_id": (template.get("template_id") or "").strip()
        or config.generate_entity_id(),
        "space_id": sid,
        "conflicts": conflicts,
        "credentials_needed": credentials_needed,
    }


# --------------------------------------------------------------------------- #
# Plan materialization + apply (runner)
# --------------------------------------------------------------------------- #


def _build_remaps(remaps: Any) -> tuple[dict[str, str], dict[str, str]]:
    """Split the user's remap list into ``(label_remap, regex_remap)`` lookups."""
    label_remap: dict[str, str] = {}
    regex_remap: dict[str, str] = {}
    for entry in remaps or []:
        if not isinstance(entry, dict):
            continue
        kind = (entry.get("kind") or "").strip()
        original = (entry.get("original_name") or "").strip()
        new = (entry.get("new_name") or "").strip()
        if not original or not new or new == original:
            continue
        if kind == "regex":
            regex_remap[original] = new
        elif kind in ("graph_label", "sequence_name"):
            label_remap[original] = new
    return label_remap, regex_remap


def _collect_ids(template: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    g = template.get("graph") or {}
    for key in ("schema_nodes", "step_nodes", "instance_nodes"):
        for node in g.get(key) or []:
            nid = (node.get("id") or "").strip()
            if nid:
                ids.add(nid)
    for rel in g.get("relationships") or []:
        rid = (rel.get("id") or "").strip()
        if rid:
            ids.add(rid)
    s = template.get("sqlite") or {}
    for row in s.get("entities") or []:
        rid = (row.get("id") or "").strip()
        if rid:
            ids.add(rid)
    for query in s.get("queries") or []:
        qid = (query.get("id") or "").strip()
        if qid:
            ids.add(qid)
        for field in ("cypher", "sqlite"):
            for stmt in query.get(field) or []:
                for match in _ID_RE.finditer(str(stmt or "")):
                    ids.add(match.group(0))
    for event in s.get("events") or []:
        eid = (event.get("id") or "").strip()
        if eid:
            ids.add(eid)
        for seq in event.get("sequences") or []:
            if isinstance(seq, str) and _ID_RE.fullmatch(seq):
                ids.add(seq)
        for seq in event.get("recovery_sequences") or []:
            if isinstance(seq, str) and _ID_RE.fullmatch(seq):
                ids.add(seq)
    return ids


def _rewrite_text(text: str, id_remap: dict[str, str], label_remap: dict[str, str]) -> str:
    """Apply id and quoted-label remaps to a cypher/sqlite/JSON string."""
    if not text:
        return text
    out = text
    for old_id, new_id in id_remap.items():
        if old_id in out:
            out = out.replace(old_id, new_id)
    for old_label, new_label in label_remap.items():
        out = out.replace(f"'{old_label}'", f"'{new_label}'")
        out = out.replace(f'"{old_label}"', f'"{new_label}"')
    return out


def _rewrite_json(value: Any, id_remap: dict[str, str], label_remap: dict[str, str]) -> Any:
    text = json.dumps(value)
    rewritten = _rewrite_text(text, id_remap, label_remap)
    try:
        return json.loads(rewritten)
    except json.JSONDecodeError:
        return value


class _PlanBuilder:
    """Accumulates the ordered statement plan for one template import.

    ``_materialize_plan`` used to be one 235-line function; each numbered section is
    now a ``_plan_*`` method appending to the same ``statements`` list in the same
    order.
    """

    def __init__(
        self,
        template: dict[str, Any],
        *,
        id_remap: dict[str, str],
        label_remap: dict[str, str],
        regex_remap: dict[str, str],
    ) -> None:
        self.template = template
        self.graph_section = template.get("graph") or {}
        self.sqlite_section = template.get("sqlite") or {}
        self.id_remap = id_remap
        self.label_remap = label_remap
        self.regex_remap = regex_remap
        self.statements: list[dict[str, Any]] = []
        self.created_labels: set[str] = set()
        self.group_titles: set[str] = set()

    def _remap_label(self, label: str) -> str:
        return self.label_remap.get(label, label)

    def _plan_credentials(self) -> None:
        """0b) Credential slots (name + description only). Registered without a value so
        the operator can inject the secret out-of-band; an existing slot is never
        overwritten."""
        for credential in self.template.get("credentials") or []:
            name = (credential.get("name") or "").strip()
            if not name:
                continue
            self.statements.append(
                {
                    "op": "credential",
                    "row": {"name": name, "description": credential.get("description") or ""},
                }
            )

    def _plan_schema_and_step_nodes(self) -> None:
        """1) SCHEMA then STEP nodes (idempotent MERGE on the regenerated id)."""
        for role, key in (("SCHEMA", "schema_nodes"), ("STEP", "step_nodes")):
            for node in self.graph_section.get(key) or []:
                old_id = (node.get("id") or "").strip()
                if not old_id:
                    continue
                label = self._remap_label((node.get("attributive_label") or "").strip())
                if label:
                    self.created_labels.add(label)
                self.statements.append(
                    {
                        "op": "cypher",
                        "cypher": (
                            f"MERGE (n:{role} {{id: $id}}) "
                            "SET n.attributive_label = $attributive_label RETURN n"
                        ),
                        "params": {
                            "id": self.id_remap.get(old_id, old_id),
                            "attributive_label": label,
                        },
                    }
                )

    def _plan_instance_nodes(self) -> None:
        """2) INSTANCE nodes carry their schema-defined data properties directly."""
        for node in self.graph_section.get("instance_nodes") or []:
            old_id = (node.get("id") or "").strip()
            if not old_id:
                continue
            props = dict(node.get("properties") or {})
            props["id"] = self.id_remap.get(old_id, old_id)
            if props.get("attributive_label"):
                props["attributive_label"] = self._remap_label(str(props["attributive_label"]))
            self.statements.append(
                {
                    "op": "cypher",
                    "cypher": "MERGE (n:INSTANCE {id: $id}) SET n += $props RETURN n",
                    "params": {"id": props["id"], "props": props},
                }
            )

    def _plan_relationships(self) -> None:
        """3) Relationships (endpoints matched by their regenerated ids)."""
        for rel in self.graph_section.get("relationships") or []:
            old_id = (rel.get("id") or "").strip()
            source = (rel.get("source") or "").strip()
            target = (rel.get("target") or "").strip()
            if not old_id or not source or not target:
                continue
            props = dict(rel.get("properties") or {})
            props["id"] = self.id_remap.get(old_id, old_id)
            if props.get("attributive_label"):
                props["attributive_label"] = self._remap_label(str(props["attributive_label"]))
                self.created_labels.add(props["attributive_label"])
            self.statements.append(
                {
                    "op": "cypher",
                    "cypher": (
                        "MATCH (a {id: $source}), (b {id: $target}) "
                        "MERGE (a)-[r:POINTS_TO {id: $id}]->(b) SET r += $props RETURN r"
                    ),
                    "params": {
                        "source": self.id_remap.get(source, source),
                        "target": self.id_remap.get(target, target),
                        "id": props["id"],
                        "props": props,
                    },
                }
            )

    def _plan_entities(self) -> None:
        """4) Per-space entity rows."""
        for row in self.sqlite_section.get("entities") or []:
            old_id = (row.get("id") or "").strip()
            if not old_id:
                continue
            node_label = (row.get("node_label") or "").strip()
            common_label = row.get("common_label")
            if node_label in ("STEP", "SCHEMA") and isinstance(common_label, str):
                common_label = self._remap_label(common_label.strip())
            payload = row.get("payload")
            if isinstance(payload, str):
                payload = _rewrite_text(payload, self.id_remap, self.label_remap)
            parameters = row.get("parameters")
            if isinstance(parameters, str):
                parameters = _rewrite_text(parameters, self.id_remap, self.label_remap)
            self.statements.append(
                {
                    "op": "entity",
                    "row": {
                        "id": self.id_remap.get(old_id, old_id),
                        "node_label": node_label,
                        "common_label": common_label,
                        "parameters": parameters,
                        "payload": payload,
                    },
                }
            )

    def _plan_queries(self) -> None:
        """5) Catalog queries (id + embedded ids/labels rewritten)."""
        for query in self.sqlite_section.get("queries") or []:
            old_id = (query.get("id") or "").strip()
            if not old_id:
                continue
            kind = (query.get("kind") or "user").strip()
            name = (query.get("name") or "").strip()
            if kind == "sequence":
                name = self._remap_label(name)
            group_title = (query.get("group_title") or "").strip() or None
            if group_title:
                self.group_titles.add(group_title)
            self.statements.append(
                {
                    "op": "query",
                    "row": {
                        "id": self.id_remap.get(old_id, old_id),
                        "name": name,
                        "kind": kind,
                        "operation": (query.get("operation") or "read").strip(),
                        "runtime_enabled": int(query.get("runtime_enabled") or 0),
                        "author_selectable": int(query.get("author_selectable") or 0),
                        "triggerable": int(
                            query.get("triggerable")
                            if query.get("triggerable") is not None
                            else 1
                        ),
                        "group_title": group_title,
                        "cypher": [
                            _rewrite_text(str(c), self.id_remap, self.label_remap)
                            for c in (query.get("cypher") or [])
                        ],
                        "sqlite": [
                            _rewrite_text(str(c), self.id_remap, self.label_remap)
                            for c in (query.get("sqlite") or [])
                        ],
                        "parameters": _rewrite_json(
                            query.get("parameters") or [], self.id_remap, self.label_remap
                        ),
                        "builder_config": json.dumps(query.get("builder_config") or {}),
                        "description": query.get("description") or "",
                        "loop_config": json.dumps(query.get("loop_config") or {}),
                    },
                }
            )

    def _plan_regex(self) -> None:
        """6) regex patterns (renamed when the operator resolved a collision)."""
        for pattern in self.sqlite_section.get("regex") or []:
            name = (pattern.get("name") or "").strip()
            if not name:
                continue
            self.statements.append(
                {
                    "op": "regex",
                    "row": {
                        "name": self.regex_remap.get(name, name),
                        "regex": pattern.get("regex") or "",
                    },
                }
            )

    def _plan_events(self) -> None:
        """7) events (scoped to the target space; sequence id references remapped)."""
        for event in self.sqlite_section.get("events") or []:
            old_id = (event.get("id") or "").strip()
            if not old_id:
                continue
            self.statements.append(
                {
                    "op": "event",
                    "row": {
                        "id": self.id_remap.get(old_id, old_id),
                        "name": (event.get("name") or "").strip(),
                        "type": (event.get("type") or "time").strip(),
                        "enabled": int(event.get("enabled") or 0),
                        "event_package": _rewrite_json(
                            event.get("event_package") or {}, self.id_remap, self.label_remap
                        ),
                        "external_package": _rewrite_json(
                            event.get("external_package") or {},
                            self.id_remap,
                            self.label_remap,
                        ),
                        "sequences": [
                            self.id_remap.get(str(sq), str(sq))
                            for sq in (event.get("sequences") or [])
                        ],
                        "recovery_sequences": [
                            self.id_remap.get(str(sq), str(sq))
                            for sq in (event.get("recovery_sequences") or [])
                        ],
                    },
                }
            )

    def build(self) -> dict[str, Any]:
        self._plan_credentials()
        self._plan_schema_and_step_nodes()
        self._plan_instance_nodes()
        self._plan_relationships()
        self._plan_entities()
        self._plan_queries()
        self._plan_regex()
        self._plan_events()
        return {
            "statements": self.statements,
            "created_labels": sorted(self.created_labels),
            "group_titles": sorted(self.group_titles),
        }


def _materialize_plan(
    template: dict[str, Any],
    *,
    id_remap: dict[str, str],
    label_remap: dict[str, str],
    regex_remap: dict[str, str],
) -> dict[str, Any]:
    """Build the ordered statement plan with fresh ids and remapped names baked in."""
    return _PlanBuilder(
        template,
        id_remap=id_remap,
        label_remap=label_remap,
        regex_remap=regex_remap,
    ).build()


def _validate_plan(
    space_id: str, plan: dict[str, Any], *, check_conflicts: bool = True
) -> list[str]:
    """Return a list of blocking validation errors; empty means the plan is safe to run.

    ``check_conflicts`` guards the name-collision checks. They run on a fresh import
    (a residual collision means the operator left a conflict unresolved), but are skipped
    on resume — a partial run legitimately created those very labels/regex already.
    """
    errors: list[str] = []
    statements = plan.get("statements") or []

    # Labels that will exist once the plan runs: those it creates plus those already present.
    plan_labels = set(plan.get("created_labels") or [])

    if check_conflicts:
        # Any final graph label that still collides means a conflict was left unresolved.
        for label in plan_labels:
            if graph.attributive_label_exists(space_id, "SCHEMA", label):
                errors.append(f"attributive_label still in use: {label!r}")

        existing_regex = {r["name"] for r in catalog.list_regex_patterns()}
        for stmt in statements:
            if stmt.get("op") == "regex":
                name = (stmt.get("row") or {}).get("name") or ""
                if name in existing_regex:
                    errors.append(f"regex name still in use: {name!r}")

    # INSTANCE creates require their SCHEMA type to exist (in the plan or already present).
    known_schema = set(plan_labels)
    for stmt in statements:
        if stmt.get("op") != "cypher":
            continue
        params = stmt.get("params") or {}
        props = params.get("props") if isinstance(params.get("props"), dict) else None
        if props is None or ":INSTANCE" not in str(stmt.get("cypher") or ""):
            continue
        schema_label = str(props.get("attributive_label") or "").strip()
        if not schema_label:
            continue
        if schema_label in known_schema:
            continue
        try:
            present = graph.attributive_label_exists(space_id, "SCHEMA", schema_label)
        except Exception:
            present = False
        if not present:
            errors.append(
                f"INSTANCE references unknown SCHEMA {schema_label!r}"
            )
    return errors


def _execute_entity(space_id: str, row: dict[str, Any]) -> None:
    conn = spaces.connect_sqlite_for_space(space_id)
    try:
        col = spaces.entities_node_label_column(conn)
        conn.execute(
            f"INSERT INTO entities (id, {col}, common_label, parameters, payload, "
            "creation_date, modified_date) "
            "VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) "
            f"ON CONFLICT(id) DO UPDATE SET {col} = excluded.{col}, "
            "common_label = excluded.common_label, parameters = excluded.parameters, "
            "payload = excluded.payload, modified_date = datetime('now')",
            (
                row.get("id"),
                row.get("node_label"),
                row.get("common_label"),
                row.get("parameters"),
                row.get("payload"),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _execute_statement(space_id: str, stmt: dict[str, Any]) -> None:
    op = stmt.get("op")
    if op == "cypher":
        graph.run_cypher_for_space(space_id, stmt["cypher"], stmt.get("params") or {})
    elif op == "entity":
        _execute_entity(space_id, stmt.get("row") or {})
    elif op == "query":
        row = stmt.get("row") or {}
        catalog.upsert_queries_catalog_row(
            row["id"],
            row.get("name") or "",
            row.get("cypher") or [],
            row.get("sqlite") or [],
            row.get("parameters") or [],
            kind=row.get("kind") or "user",
            operation=row.get("operation") or "read",
            runtime_enabled=int(row.get("runtime_enabled") or 0),
            author_selectable=int(row.get("author_selectable") or 0),
            group_title=row.get("group_title"),
            triggerable=int(row.get("triggerable") if row.get("triggerable") is not None else 1),
            builder_config=row.get("builder_config"),
            description=row.get("description") or "",
            loop_config=row.get("loop_config"),
        )
    elif op == "credential":
        row = stmt.get("row") or {}
        name = (row.get("name") or "").strip()
        if name:
            existing: set[str] = set()
            for c in credentials.list_credentials(space_id):
                cname = c.get("name") or ""
                existing.add(cname)
                existing.add(credentials.normalize_credential_name(cname))
            norm = credentials.normalize_credential_name(name)
            # Register the slot only when absent — never clobber a configured value.
            if name not in existing and norm not in existing:
                credentials.upsert_credential(
                    space_id, name, value=None, description=row.get("description") or ""
                )
    elif op == "regex":
        row = stmt.get("row") or {}
        catalog.add_regex_pattern(row.get("name") or "", row.get("regex") or "")
    elif op == "event":
        row = stmt.get("row") or {}
        catalog.upsert_event(
            row["id"],
            space_id,
            row.get("name") or "imported event",
            row.get("event_package") or {},
            row.get("sequences") or [],
            row.get("recovery_sequences") or [],
            type=row.get("type") or "time",
            enabled=int(row.get("enabled") or 0),
            external_package=row.get("external_package") or {},
        )
    else:
        raise ValueError(f"Unknown plan statement op: {op!r}")


def _finalize_space_metadata(space_id: str, plan: dict[str, Any]) -> None:
    """Register imported labels and nav group titles on the target space."""
    labels = plan.get("created_labels") or []
    if labels:
        try:
            spaces.append_space_attributive_labels(space_id, labels)
        except Exception:
            pass
    for title in plan.get("group_titles") or []:
        try:
            spaces.append_space_group(space_id, title)
        except Exception:
            pass


def apply_import(
    space_id: str, template: dict[str, Any], remaps: Any = None
) -> dict[str, Any]:
    """Validate then idempotently apply a template to *space_id*, resuming if interrupted.

    The resolved plan is persisted under the template id before any write, so a re-run
    skips already-applied statements (and every statement is a MERGE/upsert besides).
    """
    sid = (space_id or "").strip()
    if not sid:
        raise ValueError("space_id is required")
    if not isinstance(template, dict):
        raise ValueError("template must be a JSON object")

    template_id = (template.get("template_id") or "").strip() or config.generate_entity_id()
    existing = _load_import_row(template_id)

    if existing and existing.get("status") == "complete":
        return {
            "template_id": template_id,
            "status": "complete",
            "applied": len((existing.get("plan") or {}).get("statements") or []),
            "total": len((existing.get("plan") or {}).get("statements") or []),
            "resumed": True,
        }

    # Reuse the persisted plan on resume so regenerated ids stay stable; otherwise build it.
    if existing and (existing.get("plan") or {}).get("statements"):
        plan = existing["plan"]
        progress = existing.get("progress") or {}
        applied_index = int(progress.get("applied") or 0)
        resumed = True
    else:
        label_remap, regex_remap = _build_remaps(remaps)
        id_remap = {old: config.generate_entity_id() for old in _collect_ids(template)}
        plan = _materialize_plan(
            template,
            id_remap=id_remap,
            label_remap=label_remap,
            regex_remap=regex_remap,
        )
        applied_index = 0
        resumed = False
        _save_import_row(
            template_id, sid, status="pending", plan=plan, progress={"applied": 0}
        )

    errors = _validate_plan(sid, plan, check_conflicts=(applied_index == 0))
    if errors:
        _update_import_progress(
            template_id,
            status="failed",
            progress={"applied": applied_index},
            error="; ".join(errors),
        )
        raise ValueError("Template validation failed: " + "; ".join(errors))

    statements = plan.get("statements") or []
    total = len(statements)
    _update_import_progress(
        template_id, status="applying", progress={"applied": applied_index}
    )

    for index in range(applied_index, total):
        try:
            _execute_statement(sid, statements[index])
        except Exception as exc:  # noqa: BLE001 - surface the failing statement index
            _update_import_progress(
                template_id,
                status="failed",
                progress={"applied": index},
                error=f"statement {index}: {exc}",
            )
            raise
        _update_import_progress(
            template_id, status="applying", progress={"applied": index + 1}
        )

    _finalize_space_metadata(sid, plan)
    _update_import_progress(template_id, status="complete", progress={"applied": total})

    return {
        "template_id": template_id,
        "status": "complete",
        "applied": total,
        "total": total,
        "resumed": resumed,
    }


def get_import_status(space_id: str, template_id: str) -> dict[str, Any] | None:
    """Return the persisted progress for an import (for resume after an interruption)."""
    row = _load_import_row(template_id)
    if row is None:
        return None
    if (space_id or "").strip() and row.get("space_id") != (space_id or "").strip():
        return None
    total = len((row.get("plan") or {}).get("statements") or [])
    applied = int((row.get("progress") or {}).get("applied") or 0)
    return {
        "template_id": row["id"],
        "space_id": row["space_id"],
        "status": row["status"],
        "applied": applied,
        "total": total,
        "error": row.get("error"),
    }
