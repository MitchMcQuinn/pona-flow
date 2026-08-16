/**
 * Operation persistence and direct execution.
 *
 * Saving an operation is not one write: code resources are uploaded, the catalog row is
 * upserted, a STEP node is auto-wrapped around it, and optionally a one-step sequence is
 * created. There is no transaction spanning the catalog database, the per-space SQLite
 * mirror, and Neo4j, so the ordering here is load-bearing — each step is idempotent and
 * assumes the previous one succeeded.
 */

import { composer } from "@pona-flow/composer";
import { connector } from "@pona-flow/connector";
import { normalizeForCompose, primaryNodeLabel } from "./normalize.js";
import {
  buildCreateBodyWithOptions,
  buildQueriesCatalogPayload,
  cypherParamsFromQuery,
  cypherStatementsForExecution,
  entitySqliteStatements,
  type QueriesCatalogPayload,
} from "./packages.js";
import { autoWrapInSequence } from "./sequences.js";
import { autoWrapInStep, resolveStepWrapAttributiveLabel, stepWrapEntityId } from "./stepWrapLabel.js";
import {
  GRAPH_NODE_LABELS,
  type AuthoringContext,
  type BuilderConfig,
  type GraphNode,
  type GraphPayload,
  type GraphRelationship,
  type QueryObject,
  type RunResult,
} from "./types.js";

export interface SaveOperationInput {
  name: string;
  runtimeEnabled: boolean;
  addAsSequence?: boolean;
  groupTitle?: string;
  description?: string;
}

/**
 * Persist code-execution STEP scripts to the resources API before composing, so the
 * entity payload references a saved resource UID (the code never enters the payload).
 *
 * The resource id is stable per STEP node (existing resource_id, else the node's
 * entity id), which makes retries idempotent — a failed run that already saved the
 * resource updates it in place on the next attempt instead of creating a duplicate.
 * Returns a context copy with resource_ids filled in for the composer.
 */
export async function persistCodeResources<T extends AuthoringContext>(ctx: T): Promise<T> {
  const spaceId = ctx.spaceId ?? "";
  const query = ctx.query;
  if (!spaceId) return ctx;
  const editable =
    query.operation === "create"
      ? (node: { node_source?: string; alias_mode?: string }) =>
          node.node_source === "new" && node.alias_mode !== "reference"
      : query.operation === "update"
        ? () => true
        : () => false;

  let changed = false;
  const match = [];
  for (const clause of query.match) {
    if (clause.label !== "STEP") {
      match.push(clause);
      continue;
    }
    const patterns = [];
    for (const pattern of clause.patterns) {
      const path = [];
      for (const el of pattern.path) {
        if (el.kind !== "node") {
          path.push(el);
          continue;
        }
        const sp = el.node.sequencial_properties;
        if (!sp || sp.query_id || sp.step_type !== "code" || !editable(el.node)) {
          path.push(el);
          continue;
        }
        const name = (sp.resource_name ?? "").trim();
        const code = sp.code ?? "";
        if (!name || !code.trim()) {
          throw new Error("A code STEP node requires a name and code before running.");
        }
        const stableId =
          (sp.resource_id ?? "").trim() ||
          String(el.node.id_binding?.value ?? "").trim() ||
          undefined;
        const saved = await connector.upsertCodeResource(spaceId, {
          resourceId: stableId,
          name,
          description: sp.resource_description ?? "",
          language: sp.language === "javascript" ? "javascript" : "python",
          code
        });
        changed = true;
        path.push({
          ...el,
          node: {
            ...el.node,
            sequencial_properties: { ...sp, resource_id: saved.id }
          }
        });
      }
      patterns.push({ ...pattern, path });
    }
    match.push({ ...clause, patterns });
  }
  if (!changed) return ctx;
  return { ...ctx, query: { ...query, match } };
}

/**
 * Recompile and re-save a catalog operation from a stored builder_config snapshot (used by
 * schema-drift reconciliation). The QueryObject inside the snapshot has already been patched
 * to match the updated schema; this recomposes its cypher/parameters and overwrites the row,
 * preserving the operation's catalog name, runtime flag, and group.
 */
export async function resaveOperationFromConfig(
  spaceId: string,
  builderConfig: BuilderConfig,
  meta: { name: string; runtimeEnabled: boolean; groupTitle?: string | null }
): Promise<{ id: string }> {
  const query = normalizeForCompose(builderConfig.query);
  const composed = composer.composeQuery(query);
  const payload: QueriesCatalogPayload = {
    id: builderConfig.query.id,
    name: (meta.name || builderConfig.query.name || "").trim(),
    kind: "operation",
    operation: builderConfig.query.operation,
    runtime_enabled: meta.runtimeEnabled,
    author_selectable: true,
    group_title: meta.groupTitle?.trim() || undefined,
    space_id: spaceId,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: entitySqliteStatements(composed.sqlite),
    parameters: composer.queryParametersForQueriesCatalog(query),
    builder_config: builderConfig
  };
  return connector.upsertQuery(payload);
}

/**
 * Update an existing saved operation in place: recompile the edited QueryObject and overwrite the
 * catalog row (cypher/sqlite/parameters + builder_config). No STEP/sequence wrapping side-effects —
 * the STEP wrapper and any referencing sequences point at the query by id/attributive_label and do
 * not change.
 */
export async function updateQueryOperation(ctx: AuthoringContext): Promise<{ id: string }> {
  if (!ctx.spaceId) {
    throw new Error("Select a space before saving an operation.");
  }
  const prepared = await persistCodeResources(ctx);
  const catalog = buildQueriesCatalogPayload(prepared, prepared.runtimeEnabled);
  return connector.upsertQuery(catalog);
}

/** Persist a package to the catalog (queries table + space groups), then wrap it in a STEP. */
export async function saveQueryOperation(
  ctx: AuthoringContext,
  input: SaveOperationInput
): Promise<{ id: string; sequenceId?: string }> {
  const op = ctx.query.operation;
  if (op !== "read" && op !== "update" && op !== "delete" && op !== "create") {
    throw new Error("Save operation is only available for read, update, delete, or create packages.");
  }
  if (!ctx.spaceId) {
    throw new Error("Select a space before creating an operation.");
  }
  const prepared = await persistCodeResources(ctx);
  const spaceId = prepared.spaceId;
  const ownEntityId = await stepWrapEntityId(spaceId, prepared.query.id);
  const wrapName = spaceId
    ? await resolveStepWrapAttributiveLabel(spaceId, input.name, ownEntityId || undefined)
    : input.name.trim();
  const catalog = buildQueriesCatalogPayload(prepared, input.runtimeEnabled, {
    name: wrapName,
    description: input.description
  });
  const { id: operationId } = await connector.upsertQuery(catalog);
  await autoWrapInStep(spaceId, operationId, catalog.name);
  if (input.addAsSequence) {
    const wrapped = await autoWrapInSequence(
      spaceId,
      catalog.name,
      input.groupTitle,
      input.description
    );
    return { id: operationId, sequenceId: wrapped.id || undefined };
  }
  return { id: operationId };
}

/**
 * Mint values for the query's auto-generated id parameters (create-INSTANCE graph
 * ids composed as `id: $id__<alias>`). Saved operations get these minted by the
 * executor per run; direct runs execute the composed Cypher immediately, so the ids
 * are minted here instead.
 */
export async function withMintedIdParams(
  query: QueryObject,
  cypherParams: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const names = composer.autoGeneratedIdParameterNames(query);
  if (!names.length) return cypherParams;
  const params = { ...cypherParams };
  for (const name of names) {
    const current = params[name];
    if (current === undefined || current === null || current === "") {
      params[name] = await connector.generateQueryId();
    }
  }
  return params;
}

export async function runCreate(ctx: AuthoringContext): Promise<Record<string, unknown>> {
  if (!GRAPH_NODE_LABELS.includes(ctx.query.match[0]?.label)) {
    throw new Error("A primary node label is required.");
  }
  // Code STEP scripts are saved as resources first so the payload carries only a UID.
  const prepared = await persistCodeResources(ctx);
  // One-time runs execute graph/entity effects only; catalog save is handled by Create operation.
  const body = buildCreateBodyWithOptions(prepared, { includeQueriesCatalog: false });
  body.cypher_params = await withMintedIdParams(
    normalizeForCompose(prepared.query),
    body.cypher_params ?? {}
  );
  return connector.executeCreatePackage(body);
}

// --- Read / Update / Delete execution via /api/execute-query ---

interface CypherStatementResult {
  records?: Array<Record<string, unknown>>;
  graph?: GraphPayload;
  summary?: Record<string, unknown>;
}

function mergeGraphs(cypherResults: CypherStatementResult[]): GraphPayload {
  const nodes = new Map<string, GraphNode>();
  const relationships = new Map<string, GraphRelationship>();
  for (const r of cypherResults) {
    for (const n of r.graph?.nodes ?? []) nodes.set(n.element_id, n);
    for (const rel of r.graph?.relationships ?? []) relationships.set(rel.element_id, rel);
  }
  return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
}

function runResultFromCypherResults(
  cypherResults: CypherStatementResult[],
  preferGraph: boolean
): RunResult {
  const rows = cypherResults.flatMap((r) => r.records ?? []);
  const graph = mergeGraphs(cypherResults);
  const hasGraph = graph.nodes.length > 0 || graph.relationships.length > 0;
  if (preferGraph && hasGraph) {
    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return { kind: "graph", columns, rows, graph, raw: cypherResults };
  }
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  if (rows.length > 0) {
    return { kind: "table", columns, rows, graph: hasGraph ? graph : undefined, raw: cypherResults };
  }
  const summary = (cypherResults[0]?.summary ?? {}) as Record<string, unknown>;
  return { kind: "summary", summary, graph: hasGraph ? graph : undefined, raw: cypherResults };
}

/** Map a POST /api/execute-create response into a visualization RunResult. */
export function createResponseToRunResult(raw: Record<string, unknown>): RunResult | null {
  const nested = raw.result as { cypher?: CypherStatementResult[] } | undefined;
  const cypherResults = nested?.cypher ?? [];
  if (!cypherResults.length) return null;
  return runResultFromCypherResults(cypherResults, true);
}

function recordsToResult(operation: string, cypherResults: CypherStatementResult[]): RunResult {
  return runResultFromCypherResults(cypherResults, operation === "read");
}

/** Execute an already-composed read cypher package (used to run saved sequences). */
export async function runReadCypher(
  spaceId: string,
  cypher: string[],
  cypherParams: Record<string, unknown> = {}
): Promise<RunResult> {
  const data = await connector.executeQueryPackage({
    space_id: spaceId,
    operation: "read",
    node_label: "STEP",
    cypher,
    sqlite: [],
    cypher_params: cypherParams
  });
  return recordsToResult("read", (data.result?.cypher ?? []) as CypherStatementResult[]);
}

export async function runQuery(ctx: AuthoringContext): Promise<RunResult> {
  // Update STEP flow: re-save an edited code resource before composing the entity UPDATE.
  const prepared = ctx.query.operation === "update" ? await persistCodeResources(ctx) : ctx;
  const query = normalizeForCompose(prepared.query);
  const composed = composer.composeQuery(query);

  const data = await connector.executeQueryPackage({
    space_id: prepared.spaceId ?? "",
    operation: query.operation,
    node_label: primaryNodeLabel(query),
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: entitySqliteStatements(composed.sqlite),
    cypher_params: cypherParamsFromQuery(query),
    parameters: composer.queryParametersForQueriesCatalog(query)
  });
  return recordsToResult(query.operation, (data.result?.cypher ?? []) as CypherStatementResult[]);
}
