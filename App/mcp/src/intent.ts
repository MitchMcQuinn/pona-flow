/**
 * Intent arguments -> QueryObject.
 *
 * A QueryObject is a deeply nested structure (clause -> pattern -> path -> node ->
 * property -> schematic_properties) with interdependent fields. Asking a model to emit
 * one correctly in a single shot is the least reliable part of this whole surface, so
 * tools take small flat arguments instead and this module assembles the nesting. The raw
 * `query` escape hatch stays available for shapes the flat arguments cannot express.
 *
 * Everything here is pure: ids are minted by the caller and passed in, so the same
 * arguments always produce the same QueryObject and the result can be unit-tested
 * without a server.
 */

import {
  extractExactParameterRef,
  isLoopType,
  newMatchClause,
  newQuery,
  newSchematicProperties,
  normalizeAttributiveLabel,
  normalizeLoopConfig,
  normalizeSchemaPropertyKey,
  type ConditionType,
  type GraphNodeLabel,
  type LiteralOrParameter,
  type LoopComparisonOperator,
  type LoopConfig,
  type Operation,
  type Parameter,
  type PropertyBinding,
  type QueryObject,
  type SchematicProperties,
  type ValueType,
  type WhereFilter,
} from "@pona-flow/authoring";
import { VECTOR_SEARCH_DEFAULT_K, VECTOR_SEARCH_MAX_K } from "@pona-flow/composer";

export interface SchemaPropertyIntent {
  key: string;
  value_type?: string;
  format?: string;
  is_required?: boolean;
  is_key?: boolean;
  is_label?: boolean;
  is_indexed?: boolean;
  /** Include this property's value in the record's vector-search embedding text. */
  is_embedded?: boolean;
  default_value?: string;
  options?: string[];
}

export interface InstancePropertyIntent {
  key: string;
  value: string;
}

export interface WhereIntent {
  property_key: string;
  operator?: string;
  value?: string;
}

export interface ReturnIntent {
  expression: string;
  alias?: string;
}

export interface UnwindIntent {
  /** Column name each stacked value is bound as. */
  alias: string;
  /** In-scope Cypher expressions to stack, e.g. ["SUBJECT.id", "OBJECT.id"]. At least two. */
  expressions: string[];
}

export interface ParameterIntent {
  name: string;
  value_type?: string;
  value?: string;
  is_required?: boolean;
}

export interface StepHttpIntent {
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  response_parameters?: Array<{ property_path: string; parameter: string; default_value?: string }>;
}

export interface StepLocalLlmIntent {
  config_id: string;
  response_parameters?: Array<{ property_path: string; parameter: string; default_value?: string }>;
}

export interface OperationIntent {
  name: string;
  operation: Operation;
  node_label: GraphNodeLabel;
  attributive_label?: string;
  schema_properties?: SchemaPropertyIntent[];
  /** SCHEMA-level: embed this type's INSTANCE records for vector search. */
  is_vectorized?: boolean;
  instance_properties?: InstancePropertyIntent[];
  http_step?: StepHttpIntent;
  local_llm_step?: StepLocalLlmIntent;
  where?: WhereIntent[];
  return_items?: ReturnIntent[];
  /**
   * READ: stack several MATCH-scoped expressions into rows under one alias
   * (`UNWIND [a, b] AS alias`). MATCH node aliases stay unique. Feeds for_each.
   */
  unwind?: UnwindIntent;
  set_expressions?: string[];
  delete_targets?: string[];
  parameters?: ParameterIntent[];
  limit?: number;
  /**
   * READ INSTANCE semantic search. Replaces the MATCH with a Neo4j vector-index CALL;
   * the engine embeds the text at run time. Requires the SCHEMA to be is_vectorized.
   * text and k each accept exactly ``$name`` to be populated by a sequence instead.
   */
  vector_search?: {
    enabled?: boolean;
    text?: string;
    k?: number | string;
    all_labels?: boolean;
  };
}

/** Ids minted server-side and injected so this module stays pure. */
export interface MintedIds {
  queryId: string;
  /** Graph ids for each created entity, consumed in path order. */
  entityIds: string[];
}

const VALUE_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "UID",
  "radio",
  "checkbox",
  "attributive label",
]);

function valueType(raw: string | undefined, fallback: ValueType = "string"): ValueType {
  const v = (raw || "").trim();
  return (VALUE_TYPES.has(v) ? v : fallback) as ValueType;
}

/** Cypher-safe variable derived from an attributive_label (mirrors the builder default). */
export function aliasFor(attributiveLabel: string, fallback: string): string {
  const cleaned = (attributiveLabel || "").trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (!cleaned) return fallback;
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n${cleaned}`;
}

function schematicFrom(prop: SchemaPropertyIntent): SchematicProperties {
  return {
    ...newSchematicProperties(),
    value_type: valueType(prop.value_type),
    format: prop.format || "any",
    is_required: Boolean(prop.is_required),
    is_key: Boolean(prop.is_key),
    is_label: Boolean(prop.is_label),
    is_indexed: Boolean(prop.is_indexed),
    is_embedded: Boolean(prop.is_embedded),
    ...(prop.options?.length ? { options: prop.options } : {}),
  };
}

function schemaProperties(intent: OperationIntent): PropertyBinding[] {
  return (intent.schema_properties || []).map((prop) => ({
    key: normalizeSchemaPropertyKey(prop.key),
    value: prop.default_value ?? "",
    schematic_properties: schematicFrom(prop),
  }));
}

function instanceProperties(intent: OperationIntent): PropertyBinding[] {
  return (intent.instance_properties || []).map((prop) => ({
    key: normalizeSchemaPropertyKey(prop.key),
    value: prop.value ?? "",
  }));
}

function parameters(intent: OperationIntent): Parameter[] {
  return (intent.parameters || []).map((param) => ({
    name: param.name.trim(),
    data_type: "string",
    value: param.value ?? "",
    is_required: Boolean(param.is_required),
    schematic_properties: {
      ...newSchematicProperties(),
      value_type: valueType(param.value_type),
      is_required: Boolean(param.is_required),
    },
  }));
}

function whereGroup(intent: OperationIntent): { operator: "AND"; items: WhereFilter[] } | undefined {
  const filters = (intent.where || [])
    .filter((f) => (f.property_key || "").trim())
    .map(
      (f): WhereFilter => ({
        property_key: f.property_key.trim(),
        operator: (f.operator || "=") as WhereFilter["operator"],
        value: f.value ?? "",
      })
    );
  return filters.length ? { operator: "AND", items: filters } : undefined;
}

/** Vector-search k: a count clamped into range, or a $name a sequence supplies. */
function vectorSearchK(raw: number | string | undefined): LiteralOrParameter {
  if (typeof raw === "string") {
    const name = extractExactParameterRef(raw);
    if (name) return { parameter: name };
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return { value: VECTOR_SEARCH_DEFAULT_K };
  return { value: Math.min(n, VECTOR_SEARCH_MAX_K) };
}

/**
 * Assemble the QueryObject an operation tool describes.
 *
 * A create query mints a graph id for its primary node; read/update/delete match an
 * existing node by attributive_label instead. STEP and SCHEMA carry their configuration
 * in the per-space entities mirror, which is why their create path needs a concrete id.
 */
export function buildOperationQuery(intent: OperationIntent, ids: MintedIds): QueryObject {
  const query = newQuery(intent.operation);
  query.id = ids.queryId;
  query.name = intent.name.trim();
  query.parameters = parameters(intent);

  const clause = newMatchClause(intent.node_label);
  // Labels and property keys are UPPER_SNAKE. Normalizing rather than rejecting mirrors the
  // builder, which rewrites these fields as the author types, and spares the agent a
  // round-trip over a naming convention it has no way to know in advance.
  const attributiveLabel = normalizeAttributiveLabel(intent.attributive_label || "");
  const variable = aliasFor(attributiveLabel, "n1");
  const element = clause.patterns[0].path[0];
  if (element.kind !== "node") throw new Error("unreachable: new pattern starts with a node");

  element.node = {
    ...element.node,
    variable,
    attributive_label: attributiveLabel,
    properties: [],
  };

  if (intent.operation === "create") {
    element.node.node_source = "new";
    element.node.id_binding = { key: "id", value: ids.entityIds[0] ?? "" };
    if (intent.node_label === "SCHEMA") {
      element.node.properties = schemaProperties(intent);
      if (intent.is_vectorized) element.node.is_vectorized = true;
    } else if (intent.node_label === "INSTANCE") {
      element.node.properties = instanceProperties(intent);
    } else if (intent.http_step) {
      element.node.sequencial_properties = {
        step_type: "http",
        endpoint: intent.http_step.endpoint,
        method: intent.http_step.method ?? "POST",
        headers: intent.http_step.headers ?? {},
        body: intent.http_step.body ?? {},
        response_parameters: intent.http_step.response_parameters ?? [],
      };
    } else if (intent.local_llm_step) {
      element.node.sequencial_properties = {
        step_type: "local_llm",
        local_llm_config_id: intent.local_llm_step.config_id,
        response_parameters: intent.local_llm_step.response_parameters ?? [],
      };
    }
  } else {
    const where = whereGroup(intent);
    if (where) {
      element.node.where = where;
      element.node.where_enabled = true;
    }
  }

  query.match = [clause];

  if (intent.operation === "read") {
    query.return = {
      distinct: false,
      items: (intent.return_items || []).map((item) => ({
        expression: item.expression,
        ...(item.alias ? { alias: item.alias } : {}),
      })),
    };
    if (typeof intent.limit === "number") query.limit = { value: intent.limit };
    const unwindExpressions = (intent.unwind?.expressions || [])
      .map((expression) => String(expression || "").trim())
      .filter(Boolean);
    const unwindAlias = (intent.unwind?.alias || "").trim();
    if (unwindAlias && unwindExpressions.length >= 2) {
      query.unwind = {
        alias: unwindAlias,
        items: unwindExpressions.map((expression) => ({ expression })),
      };
    }
    // Vector search owns ordering and k, so it is not combined with limit/return items.
    if (intent.vector_search?.enabled) {
      query.vector_search = {
        enabled: true,
        text: intent.vector_search.text ?? "",
        k: vectorSearchK(intent.vector_search.k),
        all_labels: intent.vector_search.all_labels === true,
      };
    }
  }
  if (intent.operation === "update") {
    query.set = (intent.set_expressions || []).map((expression) => ({ expression }));
  }
  if (intent.operation === "delete") {
    query.delete = {
      detach: true,
      targets: intent.delete_targets?.length ? intent.delete_targets : [variable],
    };
  }

  return query;
}

/** Number of graph ids `buildOperationQuery` will consume for these arguments. */
export function mintedIdCount(intent: OperationIntent): number {
  return intent.operation === "create" ? 1 : 0;
}

export interface StepTransitionIntent {
  from: { id: string; attributive_label: string };
  to: { id: string; attributive_label: string };
  relationship_label: string;
  condition?: string;
  condition_type?: ConditionType;
  condition_expected?: boolean;
}

/**
 * A `(from:STEP)-[:POINTS_TO]->(to:STEP)` edge between two STEP nodes that already exist.
 *
 * Marking the endpoints `node_source: "existing"` makes the composer emit a MATCH on each
 * one by graph id before the MERGE, so the edge attaches to the real nodes instead of
 * creating empty duplicates.
 */
export function buildStepTransitionQuery(
  intent: StepTransitionIntent,
  ids: MintedIds
): QueryObject {
  const query = newQuery("create");
  query.id = ids.queryId;
  query.name = `${intent.from.attributive_label} -> ${intent.to.attributive_label}`;
  query.parameters = [];

  const fromVar = aliasFor(intent.from.attributive_label, "a1");
  const toVar = aliasFor(intent.to.attributive_label, "b1");
  const relLabel = normalizeAttributiveLabel(intent.relationship_label);

  query.match = [
    {
      label: "STEP",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: fromVar,
                alias_mode: "define",
                node_source: "existing",
                attributive_label: intent.from.attributive_label,
                id_binding: { key: "id", value: intent.from.id },
                properties: [],
              },
            },
            {
              kind: "relationship",
              relationship: {
                variable: aliasFor(relLabel, "rel1"),
                alias_mode: "define",
                type: "POINTS_TO",
                attributive_label: relLabel,
                id_binding: { key: "id", value: ids.entityIds[0] ?? "" },
                condition: intent.condition,
                condition_type: intent.condition_type ?? "null",
                ...(intent.condition_expected !== undefined
                  ? { condition_expected: intent.condition_expected }
                  : {}),
                properties: [],
              },
            },
            {
              kind: "node",
              node: {
                variable: toVar,
                alias_mode: "define",
                node_source: "existing",
                attributive_label: intent.to.attributive_label,
                id_binding: { key: "id", value: intent.to.id },
                properties: [],
              },
            },
          ],
        },
      ],
    },
  ];

  return query;
}

export interface SequenceIntent {
  id: string;
  entry_step: string;
  /**
   * Whether the sequence runs only its entry STEP or the whole POINTS_TO chain below it.
   *
   * The executor decides this by looking for a relationship pattern in the saved Cypher:
   * `MATCH (s:STEP { attributive_label: 'X' }) RETURN *` scopes the run to one step, while
   * `MATCH path = (:STEP { attributive_label: 'X' })-[*]->(downstream)` pulls in everything
   * downstream. STEP nodes are shared between sequences, so this is not cosmetic — a
   * single-step sequence must not inherit a longer sequence's chain.
   */
  traversal?: "single" | "downstream";
  parameters?: ParameterIntent[];
}

/** Flat loop arguments as an MCP tool receives them (see {@link buildLoopConfig}). */
export interface LoopIntent {
  type?: string;
  count?: number;
  condition?: { parameter?: string; operator?: string; value?: string };
  source?: string;
  max_iterations?: number;
}

/**
 * Loop arguments -> LoopConfig.
 *
 * Kept separate from {@link buildSequenceQuery} because a loop is not part of the read
 * query: the cycle lives in POINTS_TO edges, and the rule that ends it is saved on the
 * catalog row (`loop_config`). So this feeds `SequenceInput`, not the QueryObject.
 *
 * Returns undefined for a plain DAG, which is what leaves the row's column empty and the
 * executor on its single-pass walk.
 */
export function buildLoopConfig(intent: LoopIntent | undefined): LoopConfig | undefined {
  const type = (intent?.type || "dag").trim();
  if (!isLoopType(type) || type === "dag") return undefined;
  const loop: LoopConfig = { type };
  if (typeof intent?.max_iterations === "number") loop.max_iterations = intent.max_iterations;
  if (type === "for") {
    loop.count = typeof intent?.count === "number" ? intent.count : 0;
  } else if (type === "for_while") {
    loop.condition = {
      parameter: (intent?.condition?.parameter || "").trim(),
      operator: (intent?.condition?.operator || "=") as LoopComparisonOperator,
      value: intent?.condition?.value ?? ""
    };
  } else if (type === "for_each") {
    loop.source = (intent?.source || "").trim();
  }
  return normalizeLoopConfig(loop);
}

/**
 * The read query behind a sequence: match the entry STEP node by attributive_label and
 * return the subgraph the executor walks.
 */
export function buildSequenceQuery(intent: SequenceIntent): QueryObject {
  const entryStepLabel = intent.entry_step.trim();
  const query = newQuery("read");
  query.id = intent.id;
  query.name = entryStepLabel;
  query.parameters = parameters({
    name: "",
    operation: "read",
    node_label: "STEP",
    parameters: intent.parameters,
  });

  const clause = newMatchClause("STEP");
  const element = clause.patterns[0].path[0];
  if (element.kind !== "node") throw new Error("unreachable: new pattern starts with a node");
  element.node = {
    ...element.node,
    variable: aliasFor(entryStepLabel, "s1"),
    attributive_label: entryStepLabel,
    properties: [],
  };
  query.match = [clause];
  query.return = { distinct: false, items: [] };
  if (intent.traversal !== "single") query.read_traversal = "downstream";
  return query;
}
