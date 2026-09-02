// Typed builder model derived from Docs/QUERY-package.schema.json.
// The query model and the authoring-level types it needs live in @pona-flow/authoring
// (shared with the MCP server); React-only view state remains here.

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
  UnwindItem,
  UnwindClause,
  OrderByItem,
  SetValueMode,
  SetItem,
  DeleteClause,
  LiteralOrParameter,
  Parameter,
  ReturnClause,
  QueryObject,
  VectorSearchConfig,
  ComposedQuery,
  AuthoringContext,
  BuilderConfig,
  CheckStatus,
  FieldCheck,
  MatchNodePositions,
} from "@pona-flow/authoring";

export {
  GRAPH_NODE_LABELS,
  GRAPH_REL_TYPE,
  LABELS_REQUIRING_UNIQUE_ATTRIBUTIVE_LABEL,
  WHERE_COMPARISON_OPERATORS,
  WHERE_VALUE_PICKER_OPERATORS,
  WHERE_VALUELESS_OPERATORS,
  comparisonOperatorNeedsValue,
  isWhereFilter,
  isWhereGroup,
  whereFilterUsesValuePicker,
} from "@pona-flow/authoring";

import type { MatchNodePositions } from "@pona-flow/authoring";

// ---- UI-only view state (replaces legacy element.dataset flags) ----

export type ModalKind = "param" | "alias" | "attributiveLabel" | "regex" | null;

export interface ModalState {
  kind: ModalKind;
  context: Record<string, unknown> | null;
}

export interface GraphNode {
  element_id: string;
  labels: string[];
  properties: Record<string, unknown>;
  display_label?: string;
}

/**
 * A request to preload the builder from a STEP node clicked in the sequence visualizer. The
 * builder resolves the node by `attributiveLabel`: a custom-endpoint STEP opens the update STEP
 * flow with that node loaded as the match clause's initial node; an operation-backed STEP (one
 * whose sequencial_properties carry a query_id) opens the locked edit-operation view instead.
 * `nonce` lets the same target be re-applied (e.g. clicking the same node twice).
 */
export interface StepNodeBuilderSeed {
  kind: "stepNode";
  attributiveLabel: string;
  nonce: number;
}

/**
 * A request to open the create-sequence builder in edit mode for an existing sequence: the
 * builder loads the sequence's saved `builder_config` (its QueryObject snapshot) and pre-fills the
 * name / group / description fields. `nonce` lets the same target be re-applied.
 */
export interface EditSequenceBuilderSeed {
  kind: "editSequence";
  sequenceId: string;
  name: string;
  groupTitle: string;
  description: string;
  nonce: number;
}

/**
 * A request to preload the builder from a POINTS_TO relationship clicked in the sequence
 * visualizer. The builder can't edit a relationship in isolation (it needs the supporting
 * start/end nodes for the MATCH clause), so the seed carries the relationship's start STEP node
 * `startAttributiveLabel` plus the relationship's graph id `relationshipId`. The builder resolves
 * the edge from the start node's outgoing POINTS_TO edges and opens the update-STEP flow with the
 * full `(start)-[rel]->(end)` path loaded. `nonce` lets the same target be re-applied.
 */
export interface StepRelationshipBuilderSeed {
  kind: "stepRelationship";
  startAttributiveLabel: string;
  relationshipId: string;
  nonce: number;
}

export type BuilderSeed =
  | StepNodeBuilderSeed
  | EditSequenceBuilderSeed
  | StepRelationshipBuilderSeed;

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

/** Currently selected element in the graph-based match builder (config card target). */
export interface SelectedMatchElement {
  kind: "node" | "relationship";
  variable: string;
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

export interface BuilderState {
  spaceId: string | null;
  runtimeEnabled: boolean;
  query: import("@pona-flow/authoring").QueryObject;
  checks: Record<string, import("@pona-flow/authoring").FieldCheck>;
  modal: ModalState;
  savedQueries: Array<{
    id: string;
    name: string;
    operation: string;
    kind: string;
    runtimeEnabled: boolean;
    /** A SCHEMA change invalidated this query; not runnable until re-saved. */
    suspended: boolean;
  }>;
  spaceLabels: string[];
  spaceGroups: string[];
  spaceDevMode: boolean;
  spaceDefaultEndpoint: string;
  regexPatterns: Array<{ name: string; regex: string | null }>;
  run: {
    status: "idle" | "running" | "success" | "error";
    error: string | null;
    result: RunResult | null;
  };
  status: { message: string; kind: "info" | "ok" | "error" };
  // Bumped after a catalog/graph mutation so dropdowns that list existing graph nodes
  // (e.g. STEP/SCHEMA pickers) refetch and show newly created entities immediately.
  dataVersion: number;
  /** Graph-based match builder: the element whose config card is shown. */
  selectedMatchElement: SelectedMatchElement | null;
  /** Graph-based match builder: persisted canvas positions by entity variable. */
  matchPositions: MatchNodePositions;
  /**
   * Set when the builder is editing an existing saved operation (loaded from a query-backed STEP).
   * In this mode the operation/label selects are locked and the bottom actions show a single
   * "Save operation" button that updates the catalog row in place. Null in normal authoring.
   */
  editOperation: { queryId: string } | null;
  /**
   * Set when the create-sequence builder is editing an existing sequence (hydrated from its saved
   * `builder_config`). `queryId` is the sequence's catalog id, used to update the row in place.
   * The name field is the workspace title and is editable; the wrapping STEP attributive_label
   * follows only when that name is free in the graph. Null when creating.
   */
  editSequence: { queryId: string } | null;
  /**
   * Set when the builder is editing a single STEP POINTS_TO relationship loaded from the sequence
   * visualizer (the `(start)-[rel]->(end)` path in the update-STEP flow). In this mode the
   * operation/label selects are locked, the supporting start/end node cards are read-only, and the
   * pattern's hop/remove controls are hidden so the author can only edit the relationship itself.
   * Null in normal authoring.
   */
  lockedStepRelationship: boolean;
}
