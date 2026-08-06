/** Catalog SQLite: spaces.labels updates and queries table upserts. */

import { escapeSqliteString } from "../literals.js";

function formatSpaceLabelsColumn(labels: string[] | null | undefined): string {
  return JSON.stringify({ labels: labels || [] });
}

export function composeSpaceLabelsUpdateSql(
  spaceId: string,
  existingLabels: string[] | null | undefined,
  attributiveLabelsToAdd: string[] | null | undefined
): string | null {
  const sid = String(spaceId || "").trim();
  if (!sid) return null;
  const existing = Array.isArray(existingLabels)
    ? existingLabels.map((l) => String(l || "").trim()).filter(Boolean)
    : [];
  const seen = new Set(existing);
  const added: string[] = [];
  (attributiveLabelsToAdd || []).forEach((raw) => {
    const al = String(raw || "").trim();
    if (!al || seen.has(al)) return;
    seen.add(al);
    existing.push(al);
    added.push(al);
  });
  if (!added.length) return null;
  return (
    "UPDATE spaces SET labels = " +
    escapeSqliteString(formatSpaceLabelsColumn(existing)) +
    " WHERE id = " +
    escapeSqliteString(sid) +
    ";"
  );
}

/**
 * Catalog upsert SQL for a navigation sequence (kind=sequence, read, triggerable).
 * Mirrors the parameterized INSERT the dev server writes for /api/queries/upsert,
 * so the live preview reflects exactly what lands in the queries table.
 */
export function composeSequenceCatalogUpsertSql(
  pkg:
    | {
        id: string;
        name: string;
        cypher: string;
        parameters: unknown[];
        groupTitle?: string;
      }
    | null
    | undefined
): string | null {
  if (!pkg) return null;
  const id = String(pkg.id || "").trim();
  if (!id) return null;
  const name = String(pkg.name || "").trim();
  const cypherLines = String(pkg.cypher || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  const cypherJson = JSON.stringify(cypherLines);
  const parametersJson = JSON.stringify(pkg.parameters || []);
  const groupTitle = String(pkg.groupTitle || "").trim();
  const groupLiteral = groupTitle ? escapeSqliteString(groupTitle) : "NULL";
  return (
    "INSERT INTO queries (id, name, kind, operation, runtime_enabled, author_selectable, triggerable, group_title, cypher, sqlite, parameters, creation_date, modified_date) " +
    "VALUES (" +
    escapeSqliteString(id) +
    ", " +
    escapeSqliteString(name) +
    ", 'sequence', 'read', 1, 1, 1, " +
    groupLiteral +
    ", " +
    escapeSqliteString(cypherJson) +
    ", '[]', " +
    escapeSqliteString(parametersJson) +
    ", datetime('now'), datetime('now')) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "name = excluded.name, kind = excluded.kind, operation = excluded.operation, " +
    "runtime_enabled = excluded.runtime_enabled, author_selectable = excluded.author_selectable, " +
    "triggerable = excluded.triggerable, group_title = excluded.group_title, " +
    "cypher = excluded.cypher, sqlite = excluded.sqlite, parameters = excluded.parameters, " +
    "modified_date = datetime('now');"
  );
}

export function composeQueriesCatalogUpsertSql(
  pkg: {
    id: string;
    name: string;
    operation: string;
    node_label?: string;
    label?: string;
    cypher: string;
    sqlite: string[];
    parameters: unknown[];
  } | null | undefined,
  runtimeEnabled: boolean
): string | null {
  if (!pkg) return null;
  const hasParameters = Array.isArray(pkg.parameters) && pkg.parameters.length > 0;
  if (pkg.operation !== "create" && !hasParameters) return null;
  const nodeLabel = String(pkg.node_label || pkg.label || "").trim();
  if (nodeLabel !== "STEP" && !hasParameters) return null;
  const id = String(pkg.id || "").trim();
  if (!id) return null;
  const name = String(pkg.name || "").trim();
  const cypherLines = String(pkg.cypher || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  const cypherJson = JSON.stringify(cypherLines);
  const sqliteJson = JSON.stringify(pkg.sqlite || []);
  const parametersJson = JSON.stringify(pkg.parameters || []);
  const runtime = runtimeEnabled ? 1 : 0;
  const op = String(pkg.operation || "read").trim().toLowerCase();
  return (
    "INSERT INTO queries (id, name, kind, operation, runtime_enabled, author_selectable, cypher, sqlite, parameters, creation_date, modified_date) " +
    "VALUES (" +
    escapeSqliteString(id) +
    ", " +
    escapeSqliteString(name) +
    ", 'operation', " +
    escapeSqliteString(op) +
    ", " +
    runtime +
    ", 1, " +
    escapeSqliteString(cypherJson) +
    ", " +
    escapeSqliteString(sqliteJson) +
    ", " +
    escapeSqliteString(parametersJson) +
    ", datetime('now'), datetime('now')) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "name = excluded.name, kind = excluded.kind, operation = excluded.operation, " +
    "runtime_enabled = excluded.runtime_enabled, author_selectable = excluded.author_selectable, " +
    "cypher = excluded.cypher, sqlite = excluded.sqlite, parameters = excluded.parameters, " +
    "modified_date = datetime('now');"
  );
}
