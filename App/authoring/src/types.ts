// Typed authoring model derived from Docs/QUERY-package.schema.json.
// Query/composer types live in @pona-flow/composer; authoring-level types are added here.
// React-only state (BuilderState, modals, run results) stays in the UI.

export type {
  Operation,
  GraphNodeLabel,
  DataType,
  ValueType,
  StringFormat,
  ConditionType,
  HttpMethod,
  WhereOperator,
  AliasMode,
  SchematicProperties,
  PropertyBinding,
  GraphIdBinding,
  StepType,
  CodeLanguage,
  SequencialProperties,
  StepResponseParameter,
  CypherConditionPredicate,
  CypherConditionBuilder,
  NodePattern,
  RelationshipLength,
  RelationshipPattern,
  PathElement,
  GraphPattern,
  MatchClause,
  WhereComparisonOperator,
  WhereFilter,
  WhereCondition,
  WhereGroup,
  WhereItem,
  ReturnItem,
  OrderByItem,
  SetValueMode,
  SetItem,
  DeleteClause,
  LiteralOrParameter,
  Parameter,
  ReturnClause,
  QueryObject,
  VectorSearchConfig,
  LoopType,
  LoopComparisonOperator,
  LoopCondition,
  LoopConfig,
  ComposedQuery,
} from "@pona-flow/composer";

export { GRAPH_NODE_LABELS, GRAPH_REL_TYPE } from "@pona-flow/composer";

export const LABELS_REQUIRING_UNIQUE_ATTRIBUTIVE_LABEL: import("@pona-flow/composer").GraphNodeLabel[] = [
  "STEP",
  "SCHEMA",
];

export const WHERE_COMPARISON_OPERATORS: import("@pona-flow/composer").WhereComparisonOperator[] = [
  "=",
  "<>",
  ">",
  ">=",
  "<",
  "<=",
  "CONTAINS",
  "STARTS WITH",
  "ENDS WITH",
  "IS NULL",
  "IS NOT NULL",
];

/** Operators that are complete on their own — they compare against no right-hand side. */
export const WHERE_VALUELESS_OPERATORS: readonly import("@pona-flow/composer").WhereComparisonOperator[] = [
  "IS NULL",
  "IS NOT NULL",
];

/** True when the operator needs a right-hand side value to form a complete comparison. */
export function comparisonOperatorNeedsValue(
  operator: import("@pona-flow/composer").WhereComparisonOperator | undefined
): boolean {
  if (!operator) return false;
  return !(WHERE_VALUELESS_OPERATORS as readonly string[]).includes(operator);
}

/** Operators whose value is chosen from graph-backed distinct values. */
export const WHERE_VALUE_PICKER_OPERATORS: readonly import("@pona-flow/composer").WhereComparisonOperator[] = [
  "=",
  "<>",
  ">",
  ">=",
  "<",
  "<=",
];

export function whereFilterUsesValuePicker(
  operator: import("@pona-flow/composer").WhereComparisonOperator
): boolean {
  return (WHERE_VALUE_PICKER_OPERATORS as readonly string[]).includes(operator);
}

export function isWhereFilter(
  item: import("@pona-flow/composer").WhereItem
): item is import("@pona-flow/composer").WhereFilter {
  return "property_key" in item;
}

export function isWhereGroup(
  item: import("@pona-flow/composer").WhereItem
): item is import("@pona-flow/composer").WhereGroup {
  return "items" in item;
}

/** UI-only persisted canvas positions keyed by entity variable. */
export type MatchNodePositions = Record<string, { x: number; y: number }>;

/**
 * Declarative snapshot of the authoring session for a saved operation, stored in the queries
 * catalog's `builder_config` column so an operation-backed STEP can be round-tripped back into
 * the builder for editing (the composer is forward-only and has no decompiler). `query` is the
 * QueryObject source of truth; `runtimeEnabled` and `matchPositions` live outside it.
 */
export interface BuilderConfig {
  version: 1;
  query: import("@pona-flow/composer").QueryObject;
  runtimeEnabled: boolean;
  matchPositions?: MatchNodePositions;
}

// ---- Execution results ----

export interface GraphNode {
  element_id: string;
  labels: string[];
  properties: Record<string, unknown>;
  display_label?: string;
}

export interface GraphRelationship {
  element_id: string;
  type: string;
  start: string | null;
  end: string | null;
  properties: Record<string, unknown>;
}

export interface GraphPayload {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface RunResult {
  kind: "graph" | "table" | "summary" | "response";
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  graph?: GraphPayload;
  raw?: unknown;
  /** Custom-endpoint step: raw response body returned by the called endpoint. */
  response?: string;
  /** HTTP status code from a custom-endpoint step (0 when no response arrived). */
  status?: number;
  /** Whether the endpoint call succeeded (2xx and no network error). */
  ok?: boolean;
  /** Network-level error message when the endpoint call never completed. */
  error?: string;
}

// ---- Async-validation state ----

export type CheckStatus = "idle" | "checking" | "ok" | "duplicate" | "error";

export interface FieldCheck {
  status: CheckStatus;
  message?: string;
}

/**
 * Everything the authoring choreography needs about the session, and nothing more.
 *
 * The React builder passes a projection of its `BuilderState`; the MCP server constructs
 * one directly. Keeping this narrow is what lets the save/create/update flows run headless
 * in Node — `BuilderState` drags in localStorage, modals, and run results that have no
 * meaning outside the browser.
 */
export interface AuthoringContext {
  spaceId: string;
  query: import("@pona-flow/composer").QueryObject;
  runtimeEnabled: boolean;
  matchPositions?: MatchNodePositions;
}
