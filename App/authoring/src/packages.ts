/**
 * Turning a QueryObject into the wire payloads the API accepts.
 *
 * The composer emits one Cypher string and a flat SQLite array; the execution endpoints
 * want discrete statements, the entity mirror writes separated from catalog writes, and
 * parameters bound with their declared types. That translation lives here so the builder
 * and the MCP server produce byte-identical bodies for the same QueryObject.
 */

import {
  composer,
  isVectorSearchEnabled,
  vectorKLiteral,
  vectorKParameterName,
  vectorTextParameterName,
  VECTOR_PARAM_K,
  VECTOR_PARAM_TEXT,
} from "@pona-flow/composer";
import type { ExecuteCreateBody } from "@pona-flow/connector";
import { collectCreateAttributiveLabels, collectCreateEntityIds } from "./attributiveLabels.js";
import { serializeBuilderConfig } from "./builderConfig.js";
import { normalizeForCompose, primaryNodeLabel } from "./normalize.js";
import type { AuthoringContext, BuilderConfig, LoopConfig, QueryObject } from "./types.js";
import { catalogRuntimeEnabled, isStepCreateQuery } from "./validation.js";

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

// A CALL … YIELD line (vector search) opens a statement the same way MATCH does: its
// WHERE / RETURN / ORDER BY / LIMIT tail belongs to it, not to standalone statements.
const CALL_LINE = /^CALL\s/i;

// Glue consecutive MATCH lines, then MERGE/CREATE (create) or WHERE/RETURN/… (read/update/delete).
function groupCypherStatementsForExecution(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (CALL_LINE.test(lines[i])) {
      const parts: string[] = [lines[i]];
      i += 1;
      while (i < lines.length && MATCH_TAIL_LINE.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      out.push(parts.join(" "));
    } else if (MATCH_LINE.test(lines[i])) {
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
 * Bind boolean-declared parameters as real booleans on direct runs. Form fields (and JSON
 * tool arguments) yield strings, and a string 'true' stored in the graph never matches a
 * Cypher boolean filter (the sequence executor applies the same coercion server-side).
 */
export function cypherParamsFromQuery(query: QueryObject): Record<string, unknown> {
  const params = Object.fromEntries(
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
  // A literal vector-search text/k lives on QueryObject.vector_search rather than in
  // query.parameters, so it does not trip queryUsesParameters (which would hide the Run
  // button); synthesize it here the same way create ids are minted for direct runs. A
  // parameterized one is an ordinary declared parameter already bound above — and it
  // does hide Run, like any other parameterized query.
  if (isVectorSearchEnabled(query) && query.vector_search) {
    if (!vectorTextParameterName(query) && !(VECTOR_PARAM_TEXT in params)) {
      params[VECTOR_PARAM_TEXT] = String(query.vector_search.text ?? "");
    }
    if (!vectorKParameterName(query) && !(VECTOR_PARAM_K in params)) {
      params[VECTOR_PARAM_K] = vectorKLiteral(query);
    }
  }
  return params;
}

export function createExpectsEntityMirrorWrites(query: QueryObject): boolean {
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

export function buildCreateBody(ctx: AuthoringContext): ExecuteCreateBody {
  return buildCreateBodyWithOptions(ctx, { includeQueriesCatalog: true });
}

export function buildCreateBodyWithOptions(
  ctx: AuthoringContext,
  opts: { includeQueriesCatalog: boolean }
): ExecuteCreateBody {
  const query = normalizeForCompose(ctx.query);
  const composed = composer.composeQuery(query);
  const cypher = cypherStatementsForExecution(composed.cypher);
  const sqlite = entitySqliteStatements(composed.sqlite);
  if (query.operation === "create" && createExpectsEntityMirrorWrites(query) && sqlite.length === 0) {
    throw new Error(
      "No entity SQLite statements were composed. Ensure each new node has a graph id and STEP endpoint configuration."
    );
  }
  const cypher_params = cypherParamsFromQuery(query);
  const attributive_labels = collectCreateAttributiveLabels(ctx.query);

  const body: ExecuteCreateBody = {
    space_id: ctx.spaceId ?? "",
    node_label: primaryNodeLabel(query),
    cypher,
    sqlite,
    cypher_params
  };
  if (opts.includeQueriesCatalog && isStepCreateQuery(query)) {
    body.queries_catalog = buildQueriesCatalogPayload(
      ctx,
      catalogRuntimeEnabled(ctx.query, ctx.runtimeEnabled)
    );
  }
  if (attributive_labels.length) {
    body.attributive_labels = attributive_labels;
    body.attributive_label_owner_ids = collectCreateEntityIds(ctx.query);
  }
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
  /**
   * Sequences only: the termination rule for the one cycle in the STEP graph. Its own
   * column rather than a builder_config field because the executor reads it. Omitted
   * for a plain DAG walk.
   */
  loop_config?: LoopConfig;
}

export function buildQueriesCatalogPayload(
  ctx: AuthoringContext,
  runtimeEnabled: boolean,
  overrides?: { name?: string; groupTitle?: string; description?: string }
): QueriesCatalogPayload {
  const query = normalizeForCompose(ctx.query);
  const composed = composer.composeQuery(query);
  return {
    id: query.id,
    name: (overrides?.name ?? query.name).trim(),
    kind: "operation",
    operation: query.operation,
    runtime_enabled: runtimeEnabled,
    author_selectable: true,
    group_title: overrides?.groupTitle?.trim() || undefined,
    space_id: ctx.spaceId || undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: entitySqliteStatements(composed.sqlite),
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: overrides?.description?.trim() || undefined,
    builder_config: serializeBuilderConfig(ctx, runtimeEnabled)
  };
}
