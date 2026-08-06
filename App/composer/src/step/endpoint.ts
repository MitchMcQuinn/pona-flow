/** STEP entity endpoint and saved-query payload helpers. */

import { escapeCypherString, escapeSqliteString } from "../literals.js";
import type { SequencialProperties, StepResponseParameter } from "../types.js";

export function normalizeStepResponseParameters(
  items: StepResponseParameter[] | null | undefined
): StepResponseParameter[] {
  return (items ?? [])
    .map((item) => {
      const property_path = String(item.property_path ?? "").trim();
      const parameter = String(item.parameter ?? "").trim();
      const default_value = String(item.default_value ?? "").trim();
      const row: StepResponseParameter = { property_path, parameter };
      if (default_value) row.default_value = default_value;
      return row;
    })
    .filter((item) => item.property_path || item.parameter);
}

export function isStepCustomEndpoint(
  sp: SequencialProperties | null | undefined
): boolean {
  return !sp || sp.query_id === undefined;
}

/** True for a custom STEP that runs sandboxed code instead of an HTTP request. */
export function isStepCodeExecution(
  sp: SequencialProperties | null | undefined
): boolean {
  return Boolean(sp && sp.query_id === undefined && sp.step_type === "code");
}

export function stepEntityPayload(sp: SequencialProperties | null | undefined): string {
  if (sp && sp.query_id) {
    return JSON.stringify({ query_id: String(sp.query_id) });
  }
  const response_parameters = normalizeStepResponseParameters(sp?.response_parameters);
  if (isStepCodeExecution(sp)) {
    // Code steps reference their script by resource UID only — the code text lives
    // in the gitignored resources folder (saved via the resources API), never in the
    // entity payload / EXECUTION package.
    const payload: Record<string, unknown> = {
      kind: "code",
      resource_id: sp?.resource_id || ""
    };
    if (response_parameters.length > 0) {
      payload.response_parameters = response_parameters;
    }
    return JSON.stringify(payload);
  }
  const payload: Record<string, unknown> = {
    endpoint: sp?.endpoint || "",
    method: sp?.method || "POST",
    headers: sp?.headers ?? {},
    body: sp?.body ?? {}
  };
  if (response_parameters.length > 0) {
    payload.response_parameters = response_parameters;
  }
  return JSON.stringify(payload);
}

/**
 * SQLite statements that auto-wrap a saved operation in a STEP entity so the operation
 * is immediately selectable from the operations dropdown in the create STEP flow.
 *
 * The STEP entity mirrors a manually created STEP node that references the operation
 * via ``payload.query_id``. Re-saves update ``common_label`` on the existing wrap row
 * (same ``query_id``) and only INSERT when no wrap exists yet.
 */
export function composeStepWrapEntitySql(params: {
  entityId: string;
  operationId: string;
  name: string;
}): string[] | null {
  const entityId = String(params.entityId || "").trim();
  const operationId = String(params.operationId || "").trim();
  if (!entityId || !operationId) return null;
  const name = String(params.name || "").trim();
  const payload = JSON.stringify({ query_id: operationId });
  const update =
    "UPDATE entities SET common_label = " +
    escapeSqliteString(name) +
    ", modified_date = datetime('now') WHERE node_label = 'STEP' AND json_extract(payload, '$.query_id') = " +
    escapeSqliteString(operationId) +
    ";";
  const insert =
    "INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) " +
    "SELECT " +
    escapeSqliteString(entityId) +
    ", 'STEP', " +
    escapeSqliteString(name) +
    ", '[]', " +
    escapeSqliteString(payload) +
    ", datetime('now'), datetime('now') " +
    "WHERE NOT EXISTS (SELECT 1 FROM entities WHERE node_label = 'STEP' AND json_extract(payload, '$.query_id') = " +
    escapeSqliteString(operationId) +
    ");";
  return [update, insert];
}

/**
 * Cypher that mirrors the auto-wrapping STEP node into the graph, alongside the
 * ``entities`` row from ``composeStepWrapEntitySql``. The canonical node is keyed by
 * stable graph ``id``; re-saves SET ``attributive_label`` in place and remove stale
 * graph nodes that reused the label under a different id (from prior non-idempotent wraps).
 */
export function composeStepWrapGraphCypher(params: {
  entityId: string;
  operationId: string;
  name: string;
}): string[] | null {
  const entityId = String(params.entityId || "").trim();
  const operationId = String(params.operationId || "").trim();
  if (!entityId || !operationId) return null;
  const name = String(params.name || "").trim();
  const purgeStale =
    "MATCH (stale:STEP { attributive_label: " +
    escapeCypherString(name) +
    " }) WHERE stale.id <> " +
    escapeCypherString(entityId) +
    " DETACH DELETE stale";
  const merge =
    "MERGE (step:STEP { id: " +
    escapeCypherString(entityId) +
    " }) SET step.attributive_label = " +
    escapeCypherString(name) +
    " RETURN *";
  return [purgeStale, merge];
}

/**
 * Read Cypher for a one-step sequence that wraps a single STEP node. The sequence
 * executor locates the chain's initial STEP by parsing the ``attributive_label``
 * from this statement, so matching the wrapping STEP node by its label is enough
 * to make the lone operation runnable as a sequence.
 */
export function composeOneStepSequenceCypher(params: { name: string }): string | null {
  const name = String(params.name || "").trim();
  if (!name) return null;
  return (
    "MATCH (step:STEP { attributive_label: " +
    escapeCypherString(name) +
    " }) RETURN *"
  );
}
