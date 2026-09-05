/**
 * Operation persistence and direct execution.
 *
 * Saving an operation is not one write: the catalog row is upserted, a STEP node is
 * auto-wrapped around it, and (by default) a one-step sequence is created. There is no
 * transaction spanning the catalog database, the per-space SQLite mirror, and Neo4j,
 * so the ordering here is load-bearing — each step is idempotent and assumes the
 * previous one succeeded.
 */

import { composer } from "@pona-flow/composer";
import { connector } from "@pona-flow/connector";
import { collectStepCreateAttributiveLabels } from "./attributiveLabels.js";
import { normalizeForCompose, primaryNodeLabel } from "./normalize.js";
import {
  buildCreateBodyWithOptions,
  buildQueriesCatalogPayload,
  cypherParamsFromQuery,
  cypherStatementsForExecution,
  entitySqliteStatements,
  type QueriesCatalogPayload,
} from "./packages.js";
import { autoWrapInSequence, type SequencePackageResult } from "./sequences.js";
import {
  autoWrapInStep,
  maybeRetargetOperationWrap,
  resolveStepWrapAttributiveLabel
} from "./stepWrapLabel.js";
import { isSingleNewStepCreate, isStepCreateQuery } from "./validation.js";
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
  /** Defaults to true: every saved operation is also a runnable one-step sequence. */
  addAsSequence?: boolean;
  groupTitle?: string;
  description?: string;
}

/** Publish a create-STEP query: materialize the designed STEP, optionally wrap it as a sequence. */
export interface PublishStepInput {
  /** Nav/MCP sequence title. Defaults to the STEP's attributive_label when empty. */
  name: string;
  groupTitle?: string;
  description?: string;
  /** Defaults to true: wrap the materialized STEP in a one-step sequence. */
  addAsSequence?: boolean;
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
 * catalog row (cypher/sqlite/parameters + builder_config).
 *
 * The catalog ``name`` is the workspace title and always saves. The wrapping STEP
 * attributive_label follows only when that name is free in the graph and no multi-step
 * sequence MATCHES the current wrap label. The paired one-step sequence title is the
 * same workspace name and always syncs; its MATCH Cypher is rewritten only when the
 * wrap retargets.
 */
export async function updateQueryOperation(ctx: AuthoringContext): Promise<SequencePackageResult> {
  if (!ctx.spaceId) {
    throw new Error("Select a space before saving an operation.");
  }
  const operationId = ctx.query.id;
  let groupTitle: string | undefined;
  let description: string | undefined;
  try {
    const stored = await connector.fetchQueryPackage(operationId);
    groupTitle = stored.group_title || undefined;
    description = stored.description || undefined;
  } catch {
    groupTitle = undefined;
    description = undefined;
  }
  const catalog = buildQueriesCatalogPayload(ctx, ctx.runtimeEnabled, {
    name: ctx.query.name,
    groupTitle,
    description
  });
  const { id } = await connector.upsertQuery(catalog);
  const wrap = await maybeRetargetOperationWrap(ctx.spaceId, id, catalog.name);
  return {
    id,
    wrapRetargeted: wrap.retargeted,
    wrapLabel: wrap.wrapLabel
  };
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
  const spaceId = ctx.spaceId;
  // Always mint a catalog id on create. Reusing the builder's `query.id` overwrites
  // the previous operation (ON CONFLICT) and retargets its wrap STEP, which orphans
  // the one-step sequence that was just filed in the nav.
  const operationId = await connector.generateQueryId();
  const wrapName = await resolveStepWrapAttributiveLabel(spaceId, input.name);
  const catalog = buildQueriesCatalogPayload(
    { ...ctx, query: { ...ctx.query, id: operationId } },
    input.runtimeEnabled,
    {
      name: wrapName,
      description: input.description
    }
  );
  const { id: savedId } = await connector.upsertQuery(catalog);
  await autoWrapInStep(spaceId, savedId, catalog.name);
  const addAsSequence = input.addAsSequence !== false;
  if (addAsSequence) {
    const wrapped = await autoWrapInSequence(
      spaceId,
      catalog.name,
      input.groupTitle,
      input.description
    );
    return { id: savedId, sequenceId: wrapped.id || undefined };
  }
  return { id: savedId };
}

/**
 * Materialize a create-STEP query as the designed STEP (HTTP / Local LLM / query-backed)
 * and optionally wrap *that* node in a one-step sequence. Unlike `saveQueryOperation`,
 * this does not save the create-query as a catalog factory or mint a second wrap STEP.
 * Only a single new STEP (no hops) can publish this way; a chain uses Create sequence.
 */
export async function publishCreatedStepAsSequence(
  ctx: AuthoringContext,
  input: PublishStepInput
): Promise<{ sequenceId?: string; stepLabel: string }> {
  if (!isStepCreateQuery(ctx.query)) {
    throw new Error("Publishing as a sequence is only available for create STEP packages.");
  }
  if (!isSingleNewStepCreate(ctx.query)) {
    throw new Error(
      "Publishing as a sequence is only available for a single new STEP. Use Create sequence to publish a chain."
    );
  }
  if (!ctx.spaceId) {
    throw new Error("Select a space before publishing a step.");
  }
  const stepLabel = (collectStepCreateAttributiveLabels(ctx.query)[0] || "").trim();
  if (!stepLabel) {
    throw new Error("The STEP needs an attributive_label before it can be published.");
  }
  await runCreate(ctx);
  const addAsSequence = input.addAsSequence !== false;
  if (!addAsSequence) {
    return { stepLabel };
  }
  const title = input.name.trim() || stepLabel;
  const wrapped = await autoWrapInSequence(
    ctx.spaceId,
    title,
    input.groupTitle,
    input.description,
    stepLabel
  );
  return { sequenceId: wrapped.id || undefined, stepLabel };
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
  const body = buildCreateBodyWithOptions(ctx, { includeQueriesCatalog: false });
  body.cypher_params = await withMintedIdParams(
    normalizeForCompose(ctx.query),
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
  const query = normalizeForCompose(ctx.query);
  const composed = composer.composeQuery(query);

  const data = await connector.executeQueryPackage({
    space_id: ctx.spaceId ?? "",
    operation: query.operation,
    node_label: primaryNodeLabel(query),
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: entitySqliteStatements(composed.sqlite),
    cypher_params: cypherParamsFromQuery(query),
    parameters: composer.queryParametersForQueriesCatalog(query)
  });
  return recordsToResult(query.operation, (data.result?.cypher ?? []) as CypherStatementResult[]);
}
