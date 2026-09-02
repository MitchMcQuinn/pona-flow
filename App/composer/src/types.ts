/**
 * Query package schema types for the composer.
 * Derived from Docs/QUERY-package.schema.json.
 */

export type Operation = "create" | "read" | "update" | "delete";
export type GraphNodeLabel = "STEP" | "SCHEMA" | "INSTANCE";
export type DataType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
export type ValueType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "UID"
  | "radio"
  | "checkbox"
  | "attributive label";
export type StringFormat = "any" | "email" | "phone" | "point" | "URL" | "ZIP" | "color";
export type ConditionType = "null" | "cypher" | "implicit" | "query" | "parameter";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type WhereOperator = "AND" | "OR";
export type AliasMode = "define" | "reference";

export const GRAPH_NODE_LABELS: GraphNodeLabel[] = ["STEP", "SCHEMA", "INSTANCE"];
export const GRAPH_REL_TYPE = "POINTS_TO";

export interface SchematicProperties {
  value_type: ValueType;
  format?: string;
  is_required: boolean;
  is_key: boolean;
  is_label: boolean;
  is_indexed: boolean;
  /**
   * Include this property's value in the record's embedding text (vector search).
   * Opt-in per property: embedding every field buries the meaningful ones in ids and
   * codes. Only read when the SCHEMA itself is `is_vectorized`.
   */
  is_embedded?: boolean;
  /** radio + checkbox: the choices the end user picks from. */
  options?: string[];
  /** checkbox: minimum number of choices the end user must select. */
  min_choices?: number;
  /** checkbox: maximum number of choices the end user may select. */
  max_choices?: number;
}

export interface PropertyBinding {
  key: string;
  value?: unknown;
  parameter?: string;
  schematic_properties?: SchematicProperties;
  /**
   * Transient builder hint (not part of the persisted schemata): set on an existing SCHEMA
   * property loaded for an update. Existing properties are immutable — only deletion is
   * allowed — so the editor renders them read-only. Newly added properties leave this unset.
   */
  locked?: boolean;
}

export interface GraphIdBinding {
  key: "id";
  value: unknown;
  parameter?: string;
}

export interface StepResponseParameter {
  property_path: string;
  parameter: string;
  /** Value used when the response does not supply a value at property_path. */
  default_value?: string;
}

/** Custom STEP execution kind: HTTP request (default/legacy), leftover code, or local LLM. */
export type StepType = "http" | "code" | "local_llm";
export type CodeLanguage = "python" | "javascript";

export interface SequencialProperties {
  query_id?: string;
  /** Omitted/"http" -> endpoint step (legacy payloads); "code" -> leftover archived kind; "local_llm" -> named Ollama config. */
  step_type?: StepType;
  endpoint?: string;
  method?: HttpMethod;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  /** Leftover code-execution STEP (archived): catalog resource UID. */
  resource_id?: string;
  resource_name?: string;
  resource_description?: string;
  language?: CodeLanguage;
  /** Code text held in builder state only; persisted via the resources API, not the entity payload. */
  code?: string;
  /** Local LLM: catalog `local_llm_configs` row id. Prompt comes from sequence param `prompt`. */
  local_llm_config_id?: string;
  response_parameters?: StepResponseParameter[];
}

export interface CypherConditionPredicate {
  property: string;
  operator:
    | "="
    | "<>"
    | ">"
    | ">="
    | "<"
    | "<="
    | "CONTAINS"
    | "STARTS WITH"
    | "ENDS WITH"
    | "IS NULL"
    | "IS NOT NULL";
  value?: unknown;
  parameter?: string;
}

export interface CypherConditionBuilder {
  combine: WhereOperator;
  predicates: CypherConditionPredicate[];
}

export interface NodePattern {
  variable: string;
  alias_mode?: AliasMode;
  alias_ref?: string;
  alias_locked?: boolean;
  attributive_label?: string;
  labels?: GraphNodeLabel[];
  properties: PropertyBinding[];
  id_binding?: GraphIdBinding;
  sequencial_properties?: SequencialProperties;
  where_enabled?: boolean;
  where?: WhereGroup;
  node_source?: "new" | "existing";
  /**
   * SCHEMA-level: this type's INSTANCE records are embedded for vector search. Stored as a
   * sibling of `schemata` in the SCHEMA payload (like a relationship's `condition_type`),
   * because it describes the type rather than any one property.
   */
  is_vectorized?: boolean;
}

export interface RelationshipLength {
  min?: number | string;
  max?: number | string;
}

export interface RelationshipPattern {
  variable: string;
  alias_mode?: AliasMode;
  alias_ref?: string;
  alias_locked?: boolean;
  attributive_label?: string;
  type?: typeof GRAPH_REL_TYPE | string;
  direction?: "incoming" | "outgoing";
  length?: RelationshipLength;
  properties: PropertyBinding[];
  id_binding?: GraphIdBinding;
  condition?: string;
  condition_type?: ConditionType;
  // For a `parameter` condition: the boolean result the gating parameter must
  // coerce to for this transition to fire ("true"/"1" -> true; else false).
  // Lets two sibling relationships branch on a single parameter (one for the
  // true path, one for the false path). Defaults to true when omitted.
  condition_expected?: boolean;
  cypher_condition?: CypherConditionBuilder;
  required?: boolean;
  /**
   * Optional hop: this relationship and everything after it in the path render as
   * OPTIONAL MATCH segments anchored on the preceding node, so anchor nodes without
   * the hop are still matched. Applies to read SCHEMA/INSTANCE and to update/delete
   * INSTANCE (see `supportsHopSplit`); ignored everywhere else.
   */
  optional?: boolean;
  /**
   * Absent hop: this relationship and everything after it in the path render as a
   * NOT EXISTS { MATCH ... } anti-join anchored on the preceding node, so only anchor
   * nodes WITHOUT the hop are matched. Mutually exclusive with `optional`. Applies to
   * read SCHEMA/INSTANCE and to update/delete INSTANCE (see `supportsHopSplit`);
   * ignored everywhere else.
   */
  absent?: boolean;
  where_enabled?: boolean;
  where?: WhereGroup;
  node_source?: "new" | "existing";
  /** SCHEMA-level: embed this relationship type's INSTANCE edges for vector search. */
  is_vectorized?: boolean;
}

export type PathElement =
  | { kind: "node"; node: NodePattern }
  | { kind: "relationship"; relationship: RelationshipPattern };

export interface GraphPattern {
  path: PathElement[];
}

export interface MatchClause {
  label: GraphNodeLabel;
  optional?: boolean;
  patterns: GraphPattern[];
}

export type WhereComparisonOperator =
  | "="
  | "<>"
  | ">"
  | ">="
  | "<"
  | "<="
  | "CONTAINS"
  | "STARTS WITH"
  | "ENDS WITH"
  | "IS NULL"
  | "IS NOT NULL";

export interface WhereFilter {
  property_key: string;
  operator: WhereComparisonOperator;
  value?: string;
}

export interface WhereCondition {
  expression: string;
}

export interface WhereGroup {
  operator: WhereOperator;
  items: WhereItem[];
}

export type WhereItem = WhereFilter | WhereCondition | WhereGroup;

export interface ReturnItem {
  expression: string;
  alias?: string;
  path_variable?: string;
  attributive_label?: string;
  property_key?: string;
  entity_role?: "node" | "relationship";
  /**
   * Builder-only hint: project the result of a comparison against the property
   * instead of the property value itself. `expression` stays the sole compiled
   * artifact — left unset when off so pre-existing configs re-save unchanged.
   */
  boolean_mode?: boolean;
  comparison_operator?: WhereComparisonOperator;
  /** Compared-against value: a literal (e.g. "30", "active") or an exact $parameter. */
  comparison_value?: string;
}

export interface OrderByItem {
  expression: string;
  direction: "ASC" | "DESC";
  null_order?: "NULLS FIRST" | "NULLS LAST";
  /** Builder-only hints driving the schema-bound ORDER BY pickers (read INSTANCE). */
  path_variable?: string;
  attributive_label?: string;
  property_key?: string;
  entity_role?: "node" | "relationship";
}

/**
 * How a SET assignment's right-hand side is authored in the builder. `expression`
 * remains the sole compiled artifact — these are round-trip editing hints only.
 * - "literal": a literal value or exact $parameter reference (default when omitted).
 * - "now": toString(datetime()) — current timestamp as an ISO string.
 * - "not_property": (NOT coalesce(source.prop, false)) — negate a boolean property
 *   of an in-scope alias (source_variable/source_property).
 * - "expression": free-form Cypher right-hand side, validated only at run time.
 */
export type SetValueMode = "literal" | "now" | "not_property" | "expression";

export interface SetItem {
  expression: string;
  /** Builder-only hints driving the schema-bound SET pickers (update INSTANCE). */
  path_variable?: string;
  attributive_label?: string;
  property_key?: string;
  entity_role?: "node" | "relationship";
  /** Raw assignment value: a literal (e.g. "active", 42) or a $parameter reference. */
  value?: string;
  /** Builder-only hint: how the right-hand side was authored (default "literal"). */
  value_mode?: SetValueMode;
  /** Builder-only hint (not_property mode): alias whose property is negated. */
  source_variable?: string;
  /** Builder-only hint (not_property mode): boolean property being negated. */
  source_property?: string;
}

export interface DeleteClause {
  detach?: boolean;
  targets: string[];
}

export type LiteralOrParameter = { value: number } | { parameter: string } | null;

export interface Parameter {
  name: string;
  data_type: DataType;
  value: unknown;
  is_required?: boolean;
  schematic_properties?: SchematicProperties;
  /** Author-written prose; surfaced to MCP agents as the inputSchema property description. */
  description?: string;
  /**
   * Builder-only: declared by hand rather than discovered from a `$name` token, so
   * reference sync keeps it even while nothing in the query references it. Never
   * serialized into a catalog/entity row; it round-trips through `builder_config`.
   */
  declared?: boolean;
}

export interface ReturnClause {
  distinct?: boolean;
  items: ReturnItem[];
}

/**
 * Stack several in-scope expressions into rows under one column (`UNWIND [a, b] AS alias`).
 *
 * MATCH aliases stay unique (subject vs object). This is how a read feeds `for_each`
 * with one pass per id without giving two nodes the same Cypher variable. Incomplete
 * clauses (fewer than two expressions, or no alias) are not composed.
 */
export interface UnwindItem {
  expression: string;
  /** Builder hint: the MATCH alias whose property this value reads. */
  path_variable?: string;
  attributive_label?: string;
  property_key?: string;
  entity_role?: "node" | "relationship";
}

export interface UnwindClause {
  /** Column name each stacked value is bound as (`AS alias`). */
  alias: string;
  items: UnwindItem[];
}

/**
 * READ INSTANCE nearest-neighbour search over a space's Neo4j vector index.
 *
 * When enabled, the composer emits ``CALL db.index.vector.queryNodes`` instead of a
 * normal MATCH. The engine fills ``$vector_query`` (the embedding) at run time so the
 * same stored Cypher works from the builder and inside a sequence.
 */
export interface VectorSearchConfig {
  enabled: boolean;
  /**
   * Free-text query embedded with the space's Ollama model. Either a literal, or
   * exactly ``$name`` to have a sequence supply it (the whole field, not a fragment).
   */
  text: string;
  /**
   * Top-k hits after the attributive_label (and optional WHERE) filter. A bare number
   * is tolerated from snapshots saved before this became a LiteralOrParameter.
   */
  k: LiteralOrParameter | number;
  /**
   * Search every vectorized type instead of the selected attributive_label. The shared
   * :INSTANCE index already spans all of them, so this simply omits the label filter —
   * which also means the operation no longer references one SCHEMA. Compose-time only
   * (it changes the statement shape), so a sequence cannot flip it per run.
   */
  all_labels?: boolean;
}

/**
 * The termination rule for the one cycle in a sequence's STEP graph.
 *
 * The graph supplies the cycle (a POINTS_TO edge back to an earlier STEP); this
 * supplies the rule that ends it, so the shape of the work and how long it runs are
 * chosen separately. Persisted in the queries catalog's own `loop_config` column
 * rather than inside `builder_config`, because the executor reads it — see
 * Docs/EXECUTION-package.schema.json `loop`.
 */
export type LoopType = "dag" | "for" | "for_while" | "for_each";

/** Operators a for/while test may use; mirrors ReturnItem.comparison_operator. */
export type LoopComparisonOperator =
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "CONTAINS"
  | "STARTS WITH"
  | "ENDS WITH";

export interface LoopCondition {
  /** A sequence/step parameter, or a RETURN alias one of the steps publishes. */
  parameter: string;
  operator: LoopComparisonOperator;
  value: string;
}

export interface LoopConfig {
  /**
   * "dag" never re-enters a step, so a back-edge simply ends the run — the default,
   * and how every sequence authored before loops behaves. The other three iterate and
   * require the graph to contain exactly one cycle.
   */
  type: LoopType;
  /** for: how many passes. Zero skips the body entirely. */
  count?: number;
  /** for_while: tested before each pass, including the first. */
  condition?: LoopCondition;
  /** for_each: the RETURN alias whose rows are iterated, one pass per row. */
  source?: string;
  /** Hard cap on passes; exceeding it fails the run rather than spinning. */
  max_iterations?: number;
}

export interface QueryObject {
  id: string;
  name: string;
  operation: Operation;
  parameters: Parameter[];
  match: MatchClause[];
  set?: SetItem[];
  delete?: DeleteClause;
  where?: WhereGroup;
  return?: ReturnClause;
  /**
   * Optional UNWIND before RETURN on a read. Stacks `items` into rows named `alias`.
   * Ignored for create/update/delete, vector search, and STEP/SCHEMA traversal reads.
   */
  unwind?: UnwindClause;
  order_by?: OrderByItem[];
  skip?: LiteralOrParameter;
  limit?: LiteralOrParameter;
  allow_duplicates?: boolean;
  hide_duplicates?: boolean;
  /**
   * Read STEP/SCHEMA single-node traversal: "downstream" emits a directed
   * variable-length path (-[*]->), "network" an undirected one (-[*]-), both
   * returning the matched path. Ignored unless the match has exactly one node.
   */
  read_traversal?: "downstream" | "network";
  /** READ INSTANCE semantic search; ignored unless enabled on a single INSTANCE node. */
  vector_search?: VectorSearchConfig;
}

export interface ComposedQuery {
  cypher: string;
  sqlite: string[];
  parameters: Record<string, unknown>;
  operation: string;
}
