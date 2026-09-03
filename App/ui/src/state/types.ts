export type RightPanelMode =
  | "builder"
  | "inspect"
  | "params"
  | "event"
  | "space"
  | "localLlms";

/** The authenticated principal's identity + server-level capabilities (from /api/me). */
export interface Me {
  principalId: string;
  email: string | null;
  principalType: string;
  isSuperadmin: boolean;
  canCreateSpaces: boolean;
  /** Preferred IANA timezone for displaying event times; null = show UTC. */
  timezone: string | null;
}

/** A principal's effective permissions in the current space (from /api/space/permissions). */
export interface SpacePermissions {
  flows: string[];
  sequences: { all: boolean; ids: string[] };
  manageSpace: boolean;
}
export type VisualMode =
  | "design_graph"
  | "result_graph"
  | "result_table"
  | "audit_log"
  | "empty";
export type ExecutionStatus = "idle" | "validating" | "ready" | "running" | "success" | "error";

export interface AuditEntry {
  id: string;
  runAt: string;
  sequenceIds: string[];
  eventId: string | null;
  trigger: string;
  principalId: string | null;
  principalEmail: string | null;
}

export type Combinator = "AND" | "OR";

/** One conditional rule group inside an event package (time-bound trigger). */
export interface EventRuleGroup {
  combinator: Combinator;
  is_weekday: number[] | null;
  is_date_ordinal: number[] | null;
  is_date: string | null;
  is_time: string | null;
  is_month: number[] | null;
  is_year: number[] | null;
}

export interface EventPackage {
  combinator: Combinator;
  groups: EventRuleGroup[];
  /** Fixed parameter values passed to sequences when the event fires. */
  parameters: Record<string, unknown>;
  /** IANA timezone the rule values are expressed in; omitted/"UTC" = evaluate in UTC. */
  timezone?: string;
}

/** How an event is triggered: a time schedule or an inbound webhook payload. */
export type EventType = "time" | "external";

export type ExternalFilterOperator = "equals" | "contains" | "exists" | "regex";

/** One match condition evaluated against the inbound payload. */
export interface ExternalFilter {
  /** Dot/bracket JSON path into the payload (e.g. "event.type" or "items[0].id"). */
  path: string;
  operator: ExternalFilterOperator;
  /** Comparison value (ignored for the "exists" operator). */
  value: string;
}

/** Maps a payload field into a named sequence parameter. */
export interface ExternalParamMapping {
  /** Dot/bracket JSON path into the payload. */
  source_path: string;
  /** Sequence parameter name to populate. */
  parameter: string;
}

/** External-trigger config stored on an event of type "external". */
export interface ExternalPackage {
  /** High-entropy token embedded in the inbound URL; minted server-side. */
  ingest_token?: string;
  /** Optional HMAC shared secret; when set, inbound requests must be signed. */
  secret?: string;
  /** AND/OR across the filters; default AND. */
  combinator: Combinator;
  filters: ExternalFilter[];
  param_mappings: ExternalParamMapping[];
  /** Fixed fallback parameters layered under the mapped values. */
  parameters: Record<string, unknown>;
}

export interface EventSummary {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  sequences: string[];
  recoverySequences: string[];
}

export interface EventDetail extends EventSummary {
  spaceId: string;
  eventPackage: EventPackage;
  externalPackage: ExternalPackage;
  timers: { next_fire_at?: string | null; last_fired_at?: string | null };
}

export interface SequenceSummary {
  id: string;
  label: string;
  kind: "system" | "operation" | "sequence";
  /** attributive_label the sequence read query matches its initial STEP node by. */
  attributiveLabel: string;
  runtimeEnabled: boolean;
  /** A SCHEMA change invalidated an INSTANCE step; not runnable until the step is re-saved. */
  suspended: boolean;
  /** The sequence's entry STEP is missing from the graph (dangling catalog row). */
  orphaned: boolean;
  groupTitle: string | null;
  sortOrder: number | null;
  /** Prose shown to MCP agents as the tool description; editable post-hoc. */
  description: string;
  /** True when the sequence matches a single STEP (no POINTS_TO traversal). */
  singleStep: boolean;
}

export interface ParameterSchema {
  name: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "json";
  /** Raw value_type, drives which input control the params panel renders. */
  valueType?: string;
  /** radio + checkbox: choices the runner picks from. */
  options?: string[];
  /** checkbox: minimum number of choices that must be selected. */
  minChoices?: number;
  /** checkbox: maximum number of choices that may be selected. */
  maxChoices?: number;
}

/** A value a sequence produces and binds to a named parameter as its steps run. */
export interface ResponseParamSchema {
  parameter: string;
  propertyPath: string;
  defaultValue?: string;
}

export interface StepGraphNode {
  id: string;
  attributive_label: string;
  payload: Record<string, unknown>;
}

export interface StepGraphRelationship {
  id: string;
  source: string;
  target: string;
  type: string;
  attributive_label: string;
  payload: Record<string, unknown>;
}

export interface SequenceDefinition {
  id: string;
  label: string;
  stepGraph: {
    nodes: StepGraphNode[];
    relationships: StepGraphRelationship[];
  };
  parameterSchema: ParameterSchema[];
  /** Backing operation ids (step payload.query_id) that drifted from their SCHEMA. The steps
   * referencing them are highlighted red in the visualizer until the operation is re-saved. */
  affectedQueryIds: string[];
  /** attributive_labels of STEP nodes whose backing operation drifted — used to highlight
   * result-graph nodes (single-step sequences), which carry no query_id. */
  affectedStepLabels: string[];
}

export interface GraphPayload {
  nodes: Array<{ id: string; label: string }>;
  relationships: Array<{ id: string; source: string; target: string; type: string }>;
}

export interface TablePayload {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface AppState {
  spaceId: string | null;
  me: Me | null;
  permissions: SpacePermissions | null;
  spacePanelOpen: boolean;
  /** Right panel shows Local LLMs config management (left-nav section). */
  localLlmsPanelOpen: boolean;
  nav: {
    sequences: SequenceSummary[];
    groups: string[];
    selectedSequenceId: string | null;
    loading: boolean;
    error: string | null;
  };
  sequence: {
    definition: SequenceDefinition | null;
    loading: boolean;
    error: string | null;
  };
  editor: {
    selectedElement: { kind: "node" | "relationship"; id: string } | null;
    dirty: boolean;
  };
  params: {
    schema: ParameterSchema[];
    values: Record<string, unknown>;
    validity: Record<string, boolean>;
    allValid: boolean;
    touched: boolean;
    /** Response parameters the sequence produces (shown in the lower half of the panel). */
    responseParams: ResponseParamSchema[];
    /** Resolved values keyed by parameter name, updated as the sequence executes. */
    responseValues: Record<string, unknown>;
  };
  run: {
    status: ExecutionStatus;
    lastRunId: string | null;
    error: string | null;
    /**
     * True while a sequence run is paused mid-execution waiting for more input
     * (human-in-the-loop). Inputs already consumed by executed steps are locked
     * only in this phase; a completed/idle run unlocks them for a fresh re-run.
     */
    awaitingParams: boolean;
  };
  view: {
    rightPanelMode: RightPanelMode;
    visualMode: VisualMode;
  };
  createSequence: boolean;
  events: {
    items: EventSummary[];
    selectedEventId: string | null;
    loading: boolean;
    error: string | null;
  };
  createEvent: boolean;
  auditLog: {
    entries: AuditEntry[];
    loading: boolean;
    error: string | null;
  };
  results: {
    kind: "graph" | "table" | null;
    graphData: GraphPayload | null;
    tableData: TablePayload | null;
  };
}
