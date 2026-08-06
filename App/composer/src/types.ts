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

/** Custom STEP execution kind: HTTP request (default/legacy) or sandboxed code. */
export type StepType = "http" | "code";
export type CodeLanguage = "python" | "javascript";

export interface SequencialProperties {
  query_id?: string;
  /** Omitted/"http" -> endpoint step (legacy payloads); "code" -> code-execution step. */
  step_type?: StepType;
  endpoint?: string;
  method?: HttpMethod;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  /** Code execution: catalog `resources` row backing this step's script. */
  resource_id?: string;
  resource_name?: string;
  resource_description?: string;
  language?: CodeLanguage;
  /** Code text held in builder state only; persisted via the resources API, not the entity payload. */
  code?: string;
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
   * Optional hop (read SCHEMA/INSTANCE only): this relationship and everything after
   * it in the path render as OPTIONAL MATCH segments anchored on the preceding node,
   * so anchor nodes without the hop still return. Ignored for STEP clauses and
   * non-read operations.
   */
  optional?: boolean;
  /**
   * Absent hop (read SCHEMA/INSTANCE only): this relationship and everything after
   * it in the path render as a NOT EXISTS { MATCH ... } anti-join anchored on the
   * preceding node, so only anchor nodes WITHOUT the hop return. Mutually exclusive
   * with `optional`. Ignored for STEP clauses and non-read operations.
   */
  absent?: boolean;
  where_enabled?: boolean;
  where?: WhereGroup;
  node_source?: "new" | "existing";
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
}

export interface ReturnClause {
  distinct?: boolean;
  items: ReturnItem[];
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
}

export interface ComposedQuery {
  cypher: string;
  sqlite: string[];
  parameters: Record<string, unknown>;
  operation: string;
}
