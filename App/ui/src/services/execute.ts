import composer from "./composer";
import { resolveStepWrapAttributiveLabel } from "./stepWrapLabel";
import connector, { type ExecuteCreateBody } from "./connector";
import { upsertCodeResource } from "./resources";
import { collectCreateAttributiveLabels } from "../state/builder/attributiveLabels";
import { normalizeForCompose } from "../state/builder/selectors";
import { catalogRuntimeEnabled, isStepCreateQuery } from "../state/builder/validation";
import { GRAPH_NODE_LABELS } from "../state/builder/types";
import {
  oneStepSequenceBuilderConfig,
  serializeBuilderConfig
} from "../state/builder/builderConfig";
import type {
  BuilderConfig,
  BuilderState,
  GraphPayload,
  GraphNode,
  GraphRelationship,
  QueryObject,
  RunResult
} from "../state/builder/types";

// --- Cypher statement splitting ---

function splitCypherLines(cypherText: string): string[] {
  const chunks = (cypherText || "").split(/\s*;\s*\n/);
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      lines.push(trimmed);
    }
  }
  return lines;
}

// Clauses that belong on the same Cypher statement as a preceding MATCH block (read/update/delete).
// OPTIONAL MATCH may follow the block's WHERE (optional hops compose after the base filter).
const MATCH_TAIL_LINE =
  /^(WHERE|RETURN|WITH|ORDER BY|SKIP|LIMIT|SET|DELETE|DETACH DELETE|OPTIONAL\s+MATCH)\s/i;

// MATCH and OPTIONAL MATCH lines (optional hops / optional clauses) glue into one statement.
const MATCH_LINE = /^(OPTIONAL\s+)?MATCH\s/i;

// Glue consecutive MATCH lines, then MERGE/CREATE (create) or WHERE/RETURN/… (read/update/delete).
function groupCypherStatementsForExecution(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (MATCH_LINE.test(lines[i])) {
      const parts: string[] = [];
      while (i < lines.length && MATCH_LINE.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /^(MERGE|CREATE)\s/i.test(lines[i]) && !/^CREATE\s+INDEX\b/i.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
        if (i < lines.length && /^RETURN\s/i.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      } else {
        while (i < lines.length && MATCH_TAIL_LINE.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      }
      out.push(parts.join(" "));
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out;
}

/** One Neo4j statement per composer semicolon chunk (each may contain several MATCH clauses). */
function cypherStatementsFromSemicolonChunks(cypherText: string): string[] {
  return (cypherText || "")
    .split(/\s*;\s*\n/)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"))
        .join(" ")
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

export function cypherStatementsForExecution(cypher: string): string[] {
  const semicolonChunks = (cypher || "").split(/\s*;\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (semicolonChunks.length > 1) {
    return cypherStatementsFromSemicolonChunks(cypher);
  }
  return groupCypherStatementsForExecution(splitCypherLines(cypher));
}

function isQueriesCatalogUpsertSql(stmt: string): boolean {
  const t = String(stmt || "").trim().replace(/\s+/g, " ");
  return /^INSERT\s+INTO\s+queries\s/i.test(t) && /\bON\s+CONFLICT\s*\(\s*id\s*\)/i.test(t);
}

export function entitySqliteStatements(sqlite: string[]): string[] {
  return (sqlite || []).filter((s) => !isQueriesCatalogUpsertSql(s));
}

/**
 * Bind boolean-declared parameters as real booleans on direct builder runs. Form
 * fields yield strings, and a string 'true' stored in the graph never matches a
 * Cypher boolean filter (the sequence executor applies the same coercion server-side).
 */
function cypherParamsFromQuery(query: QueryObject): Record<string, unknown> {
  return Object.fromEntries(
    (query.parameters || []).map((p) => {
      const valueType = p.schematic_properties?.value_type ?? p.data_type;
      let value: unknown = p.value;
      if (valueType === "boolean" && typeof value === "string") {
        const t = value.trim().toLowerCase();
        if (t === "true" || t === "1") value = true;
        else if (t === "false" || t === "0") value = false;
      }
      return [p.name, value];
    })
  );
}

function createExpectsEntityMirrorWrites(query: ReturnType<typeof normalizeForCompose>): boolean {
  for (const clause of query.match || []) {
    const label = clause.label || "";
    // INSTANCE nodes are graph-only and never mirror into the entities table, so
    // they must not be required to produce entity SQLite (see composeEntitySqlite).
    if (label !== "STEP" && label !== "SCHEMA") continue;
    for (const pattern of clause.patterns || []) {
      for (const step of pattern.path || []) {
        if (step.kind === "node" && step.node) {
          if (step.node.alias_mode === "reference" || step.node.node_source === "existing") {
            continue;
          }
          const id = step.node.id_binding?.value;
          if (id !== undefined && id !== null && String(id).trim() !== "") return true;
        }
        if (step.kind === "relationship" && step.relationship) {
          if (step.relationship.alias_mode === "reference") {
            continue;
          }
          const id = step.relationship.id_binding?.value;
          if (id !== undefined && id !== null && String(id).trim() !== "") return true;
        }
      }
    }
  }
  return false;
}

/**
 * Persist code-execution STEP scripts to the resources API before composing, so the
 * entity payload references a saved resource UID (the code never enters the payload).
 *
 * The resource id is stable per STEP node (existing resource_id, else the node's
 * entity id), which makes retries idempotent — a failed run that already saved the
 * resource updates it in place on the next attempt instead of creating a duplicate.
 * Returns a state copy with resource_ids filled in for the composer.
 */
export async function persistCodeResources(state: BuilderState): Promise<BuilderState> {
  const spaceId = state.spaceId ?? "";
  const query = state.query;
  if (!spaceId) return state;
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
        const saved = await upsertCodeResource(spaceId, {
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
  if (!changed) return state;
  return { ...state, query: { ...query, match } };
}

export function buildCreateBody(state: BuilderState): ExecuteCreateBody {
  return buildCreateBodyWithOptions(state, { includeQueriesCatalog: true });
}

export function buildCreateBodyWithOptions(
  state: BuilderState,
  opts: { includeQueriesCatalog: boolean }
): ExecuteCreateBody {
  const query = normalizeForCompose(state.query);
  const composed = composer.composeQuery(query);
  const cypher = cypherStatementsForExecution(composed.cypher);
  const sqlite = entitySqliteStatements(composed.sqlite);
  if (query.operation === "create" && createExpectsEntityMirrorWrites(query) && sqlite.length === 0) {
    throw new Error(
      "No entity SQLite statements were composed. Ensure each new node has a graph id and STEP endpoint configuration."
    );
  }
  const cypher_params = cypherParamsFromQuery(query);
  const attributive_labels = collectCreateAttributiveLabels(state.query);

  const body: ExecuteCreateBody = {
    space_id: state.spaceId ?? "",
    node_label: query.match[0]?.label ?? "STEP",
    cypher,
    sqlite,
    cypher_params
  };
  if (opts.includeQueriesCatalog && isStepCreateQuery(query)) {
    body.queries_catalog = buildQueriesCatalogPayload(
      state,
      catalogRuntimeEnabled(state.query, state.runtimeEnabled)
    );
  }
  if (attributive_labels.length) body.attributive_labels = attributive_labels;
  return body;
}

export interface QueriesCatalogPayload {
  id: string;
  name: string;
  kind: string;
  operation: string;
  runtime_enabled: boolean;
  author_selectable: boolean;
  triggerable?: boolean;
  group_title?: string;
  space_id?: string;
  cypher: string[];
  sqlite: string[];
  parameters: unknown[];
  /** Prose shown to MCP agents as the tool description (sequences) / saved with operations. */
  description?: string;
  /** Declarative builder snapshot for round-trip editing; set for operations, omitted for sequences. */
  builder_config?: BuilderConfig;
}

export interface SaveOperationInput {
  name: string;
  runtimeEnabled: boolean;
  addAsSequence?: boolean;
  groupTitle?: string;
  description?: string;
}

export function buildQueriesCatalogPayload(
  state: BuilderState,
  runtimeEnabled: boolean,
  overrides?: { name?: string; groupTitle?: string; description?: string }
): QueriesCatalogPayload {
  const query = normalizeForCompose(state.query);
  const composed = composer.composeQuery(query);
  return {
    id: query.id,
    name: (overrides?.name ?? query.name).trim(),
    kind: "operation",
    operation: query.operation,
    runtime_enabled: runtimeEnabled,
    author_selectable: true,
    group_title: overrides?.groupTitle?.trim() || undefined,
    space_id: state.spaceId ?? undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: entitySqliteStatements(composed.sqlite),
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: overrides?.description?.trim() || undefined,
    builder_config: serializeBuilderConfig(state, runtimeEnabled)
  };
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
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) {
    throw new Error(data.error || `queries upsert failed (${res.status})`);
  }
  return { id: data.id ?? payload.id };
}

/**
 * Update an existing saved operation in place from the locked edit-operation view: recompile the
 * edited QueryObject and overwrite the catalog row (cypher/sqlite/parameters + builder_config). No
 * STEP/sequence wrapping side-effects — the STEP wrapper and any referencing sequences point at the
 * query by id/attributive_label and do not change.
 */
export async function updateQueryOperation(
  state: BuilderState
): Promise<{ id: string }> {
  if (!state.spaceId) {
    throw new Error("Select a space before saving an operation.");
  }
  state = await persistCodeResources(state);
  const catalog = buildQueriesCatalogPayload(state, state.runtimeEnabled);
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) {
    throw new Error(data.error || `queries upsert failed (${res.status})`);
  }
  return { id: data.id ?? catalog.id };
}

/** Persist package to catalog (queries table + space groups). */
export async function saveQueryOperation(
  state: BuilderState,
  input: SaveOperationInput
): Promise<{ id: string; sequenceId?: string }> {
  const op = state.query.operation;
  if (op !== "read" && op !== "update" && op !== "delete" && op !== "create") {
    throw new Error("Save operation is only available for read, update, delete, or create packages.");
  }
  if (!state.spaceId) {
    throw new Error("Select a space before creating an operation.");
  }
  state = await persistCodeResources(state);
  const spaceId = state.spaceId ?? "";
  const queryId = state.query.id;
  let ownEntityId = "";
  if (spaceId) {
    try {
      ownEntityId = (await connector.fetchStepWrapEntityId({ spaceId, operationId: queryId })).trim();
    } catch {
      ownEntityId = "";
    }
  }
  const wrapName = spaceId
    ? await resolveStepWrapAttributiveLabel(spaceId, input.name, ownEntityId || undefined)
    : input.name.trim();
  const catalog = buildQueriesCatalogPayload(state, input.runtimeEnabled, {
    name: wrapName,
    description: input.description
  });
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(catalog)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) {
    throw new Error(data.error || `queries upsert failed (${res.status})`);
  }
  const operationId = data.id ?? catalog.id;
  await autoWrapInStep(state, operationId, catalog.name);
  if (input.addAsSequence) {
    const wrapped = await autoWrapInSequence(
      state,
      catalog.name,
      input.groupTitle,
      input.description
    );
    return { id: operationId, sequenceId: wrapped.id || undefined };
  }
  return { id: operationId };
}

/**
 * Wrap the auto-created STEP node in a one-step sequence (catalog kind=sequence,
 * read, triggerable). The sequence's read Cypher matches the wrapping STEP node by
 * its attributive_label, so the lone operation becomes runnable as a sequence
 * without any manual sequence-building step. ``groupTitle`` files the sequence under
 * a navigation group (the upsert endpoint registers it on the space).
 */
async function autoWrapInSequence(
  state: BuilderState,
  name: string,
  groupTitle?: string,
  description?: string
): Promise<{ id: string }> {
  const cypher = composer.composeOneStepSequenceCypher({ name });
  if (!cypher) return { id: "" };
  const sequenceId = await connector.generateQueryId();
  const payload: QueriesCatalogPayload = {
    id: sequenceId,
    name: name.trim(),
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: groupTitle?.trim() || undefined,
    space_id: state.spaceId ?? undefined,
    cypher: [cypher],
    sqlite: [],
    parameters: [],
    description: description?.trim() || undefined,
    // The auto-wrapped sequence never passes through the visual builder, so synthesize the
    // matching STEP-by-attributive_label snapshot here; otherwise it persists an empty
    // builder_config and can't be opened in the create-sequence editor.
    builder_config: oneStepSequenceBuilderConfig(sequenceId, name)
  };
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `sequence auto-wrap failed (${res.status})`);
  }
  return { id: sequenceId };
}

/**
 * Auto-create a STEP node (entities row + graph node) that wraps a freshly saved
 * operation or sequence so it is immediately selectable from the operations dropdown
 * in the create STEP flow, eliminating the manual "wrap in a STEP node" step. Both
 * writes are idempotent, so re-saving never produces a duplicate wrapping STEP node.
 */
async function autoWrapInStep(
  state: BuilderState,
  wrappedId: string,
  name: string
): Promise<void> {
  const spaceId = state.spaceId ?? "";
  let entityId = "";
  if (spaceId) {
    try {
      entityId = (await connector.fetchStepWrapEntityId({ spaceId, operationId: wrappedId })).trim();
    } catch {
      entityId = "";
    }
  }
  if (!entityId) {
    entityId = await connector.generateQueryId();
  }
  const params = { entityId, operationId: wrappedId, name };
  const sqlite = composer.composeStepWrapEntitySql(params) ?? [];
  const cypher = composer.composeStepWrapGraphCypher(params) ?? [];
  if (!sqlite.length && !cypher.length) return;
  // Register the wrapping STEP node's attributive_label in the active space's labels
  // array (catalog spaces.labels), so it surfaces like any manually created STEP node.
  const attributive_labels = name.trim() ? [name.trim()] : [];
  const res = await fetch(connector.joinApiPath("/api/execute-create"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: state.spaceId ?? "",
      node_label: "STEP",
      cypher,
      sqlite,
      cypher_params: {},
      attributive_labels
    })
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `step auto-wrap failed (${res.status})`);
  }
}

/** Persist a navigation sequence (kind=sequence, read, triggerable) to the catalog. */
export async function saveSequencePackage(
  state: BuilderState,
  input: { id: string; name: string; groupTitle: string; description?: string }
): Promise<{ id: string }> {
  if (!state.spaceId) {
    throw new Error("Select a space before creating a sequence.");
  }
  const spaceId = state.spaceId;
  const query = normalizeForCompose(state.query);
  const composed = composer.composeQuery(query);
  const id = input.id.trim();
  const wrapName = await resolveStepWrapAttributiveLabel(spaceId, input.name);
  const payload: QueriesCatalogPayload = {
    id,
    name: wrapName,
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: input.groupTitle.trim() || undefined,
    space_id: state.spaceId ?? undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: [],
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: input.description?.trim() || undefined,
    // Declarative builder snapshot so the sequence can be round-tripped back into the
    // create-sequence builder for visual editing (the composer is forward-only).
    builder_config: serializeBuilderConfig(state, true)
  };
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) {
    throw new Error(data.error || `queries upsert failed (${res.status})`);
  }
  const sequenceId = data.id ?? id;
  await autoWrapInStep(state, sequenceId, payload.name);
  return { id: sequenceId };
}

/**
 * Update an existing saved sequence in place from the edit-sequence builder view: recompile the
 * edited STEP-chain read query and overwrite the catalog row (cypher/parameters + builder_config),
 * keeping the same id. The sequence name (its STEP attributive_label) is locked in the edit view,
 * so the wrapping STEP node and any referencing chains stay valid — no re-wrap side effects.
 */
export async function updateSequencePackage(
  state: BuilderState,
  input: { id: string; name: string; groupTitle: string; description?: string }
): Promise<{ id: string }> {
  if (!state.spaceId) {
    throw new Error("Select a space before editing a sequence.");
  }
  const query = normalizeForCompose(state.query);
  const composed = composer.composeQuery(query);
  const id = input.id.trim();
  const payload: QueriesCatalogPayload = {
    id,
    name: input.name.trim(),
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: input.groupTitle.trim() || undefined,
    space_id: state.spaceId ?? undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: [],
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: input.description?.trim() || undefined,
    builder_config: serializeBuilderConfig(state, true)
  };
  const res = await fetch(connector.joinApiPath("/api/queries/upsert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) {
    throw new Error(data.error || `queries upsert failed (${res.status})`);
  }
  return { id: data.id ?? id };
}

/**
 * Mint values for the query's auto-generated id parameters (create-INSTANCE graph
 * ids composed as `id: $id__<alias>`). Saved operations get these minted by the
 * executor per run; direct builder runs execute the composed Cypher immediately, so
 * the ids are minted here instead.
 */
async function withMintedIdParams(
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

export async function runCreate(state: BuilderState): Promise<Record<string, unknown>> {
  if (!GRAPH_NODE_LABELS.includes(state.query.match[0]?.label)) {
    throw new Error("A primary node label is required.");
  }
  // Code STEP scripts are saved as resources first so the payload carries only a UID.
  const prepared = await persistCodeResources(state);
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

interface ExecuteQueryResponse {
  result?: {
    operation?: string;
    cypher?: CypherStatementResult[];
    sqlite?: Array<{ rowcount?: number; lastrowid?: number }>;
  };
  error?: string;
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

/** Map POST /api/execute-create response into a visualization RunResult. */
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
  const res = await fetch(connector.joinApiPath("/api/execute-query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: spaceId,
      operation: "read",
      node_label: "STEP",
      cypher,
      sqlite: [],
      cypher_params: cypherParams
    })
  });
  const data: ExecuteQueryResponse = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `execute-query failed (${res.status})`);
  }
  return recordsToResult("read", data.result?.cypher ?? []);
}

export async function runQuery(state: BuilderState): Promise<RunResult> {
  // Update STEP flow: re-save an edited code resource before composing the entity UPDATE.
  if (state.query.operation === "update") {
    state = await persistCodeResources(state);
  }
  const query = normalizeForCompose(state.query);
  const composed = composer.composeQuery(query);
  const cypher = cypherStatementsForExecution(composed.cypher);
  const sqlite = entitySqliteStatements(composed.sqlite);
  const cypher_params = cypherParamsFromQuery(query);

  const res = await fetch(connector.joinApiPath("/api/execute-query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: state.spaceId ?? "",
      operation: query.operation,
      node_label: query.match[0]?.label ?? "STEP",
      cypher,
      sqlite,
      cypher_params
    })
  });
  const data: ExecuteQueryResponse = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `execute-query failed (${res.status})`);
  }
  return recordsToResult(query.operation, data.result?.cypher ?? []);
}
