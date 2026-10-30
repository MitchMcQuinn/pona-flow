import type {
  ChatBatchResult,
  ChatModelSettings,
  ChatStackItem,
  ChatStreamEvent,
  ChatThread,
  ChatThreadSummary
} from "../chat/types";
import type {
  AuditEntry,
  EventDetail,
  EventPackage,
  EventSummary,
  ExternalPackage,
  Me,
  SimulationPackage,
  SequenceDefinition,
  SequenceSummary,
  SpacePermissions
} from "../state/types";
import type { GraphPayload, RunResult } from "../state/builder/types";
import {
  fetchGeneratedId,
  fetchSpaceGroups as connectorFetchSpaceGroups
} from "@pona-flow/connector";
import { runReadCypher } from "./execute";

// ----- shared request helpers ------------------------------------------------
//
// Every endpoint speaks the same contract: JSON in/out, and on failure the body
// is `{"error": ...}` (see the server's global exception handler). These helpers
// replace the hand-rolled fetch -> json -> !ok -> throw block each call site used
// to carry. The server's `error` field wins over the caller's fallback message.

type ApiErrorBody = { error?: string; detail?: string };

async function apiRequest<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string | ((response: Response, data: ApiErrorBody) => string)
): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    const message = typeof fallback === "function" ? fallback(response, data) : fallback;
    throw new Error(data.error || message);
  }
  return data as T;
}

function getJson<T>(
  url: string,
  fallback: string,
  init?: RequestInit
): Promise<T> {
  return apiRequest<T>(url, init, fallback);
}

function sendJson<T>(
  method: "POST" | "PUT",
  url: string,
  body: unknown,
  fallback: string | ((response: Response, data: ApiErrorBody) => string)
): Promise<T> {
  return apiRequest<T>(
    url,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    fallback
  );
}

function postJson<T>(
  url: string,
  body: unknown,
  fallback: string | ((response: Response, data: ApiErrorBody) => string)
): Promise<T> {
  return sendJson<T>("POST", url, body, fallback);
}

function deleteJson<T>(url: string, fallback: string): Promise<T> {
  return apiRequest<T>(url, { method: "DELETE" }, fallback);
}

type SpacesResponse = {
  spaces?: Array<{ id: string; name?: string }>;
};

type QueriesResponse = {
  queries?: Array<{
    id?: string;
    name?: string;
    kind?: string;
    runtime_enabled?: number;
    suspended?: number;
    group_title?: string | null;
    sort_order?: number | null;
    parameters?: Array<{ name?: string }>;
    cypher?: string[] | string;
    description?: string;
    single_step?: boolean;
  }>;
};

export async function fetchSpaces(): Promise<Array<{ id: string; label: string }>> {
  const data = await getJson<SpacesResponse>("/api/spaces", "Failed to load spaces");
  return (data.spaces || []).map((space) => ({
    id: space.id,
    label: space.name || space.id
  }));
}

export interface CreateSpaceInput {
  name: string;
  endpoint?: string;
  /** Prose describing the space; surfaced to MCP clients as the server's instructions. */
  description?: string;
  /** When true, the builder shows composed Cypher and SQLite previews. */
  dev_mode?: boolean;
}

export interface CreateSpaceResult {
  id: string;
  name: string;
  endpoint?: string | null;
  labels?: string[];
  is_private?: boolean;
  description?: string;
  dev_mode?: boolean;
  hide_empty_sequence_groups?: boolean;
  creation_date?: string;
}

export async function createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult> {
  return postJson<CreateSpaceResult>(
    "/api/spaces/create",
    {
      name: input.name.trim(),
      endpoint: input.endpoint?.trim() || null,
      description: input.description?.trim() ?? ""
    },
    "Failed to create space"
  );
}

export interface SpaceRecord {
  id: string;
  name: string;
  endpoint?: string | null;
  labels?: string[];
  is_private?: boolean;
  dev_mode?: boolean;
  hide_empty_sequence_groups?: boolean;
  description?: string;
}

export async function fetchSpaceRecord(spaceId: string): Promise<SpaceRecord> {
  return getJson<SpaceRecord>(
    `/api/space/record?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load space",
    { cache: "no-store" }
  );
}

export async function updateSpace(
  spaceId: string,
  input: CreateSpaceInput
): Promise<CreateSpaceResult> {
  const payload: Record<string, unknown> = {
    space_id: spaceId,
    name: input.name.trim(),
    endpoint: input.endpoint?.trim() || null,
    description: input.description?.trim() ?? "",
    dev_mode: Boolean(input.dev_mode)
  };
  return postJson<CreateSpaceResult>("/api/spaces/update", payload, "Failed to update space");
}

export async function deleteSpace(spaceId: string): Promise<{ id: string; deleted: boolean }> {
  const data = await postJson<{ id?: string; deleted?: boolean }>(
    "/api/spaces/delete",
    { space_id: spaceId },
    "Failed to delete space"
  );
  return { id: data.id ?? spaceId, deleted: Boolean(data.deleted) };
}

/** Clear one space's graph and authored records. The space, accounts, and settings stay. */
export async function resetSpaceData(spaceId: string, confirmName: string): Promise<void> {
  await postJson<unknown>(
    "/api/spaces/reset",
    { space_id: spaceId, confirm: confirmName },
    "Failed to reset space"
  );
}

/** Erase the instance. The server clears the session when first-run setup is required again. */
export async function factoryResetInstance(): Promise<{ setupRequired: boolean }> {
  const data = await postJson<{ setup_required?: boolean }>(
    "/api/instance/factory-reset",
    { confirm: "RESET INSTANCE" },
    "Failed to factory reset"
  );
  return { setupRequired: Boolean(data.setup_required) };
}

export interface SchemaDeleteRef {
  id: string;
  name: string;
  operation?: string;
}

export interface SchemaDeleteWarning {
  type: string;
  blocking: boolean;
  requires_confirmation?: boolean;
  message: string;
  schemas?: string[];
}

export interface SchemaDeletePreview {
  space_id: string;
  attributive_label: string;
  requires_confirmation: boolean;
  summary: {
    instances: number;
    relationship_patterns: number;
    queries: number;
    sequences: number;
    steps: number;
    execution_packages: number;
    dependent_schemas: number;
  };
  affected: {
    labels: string[];
    relationship_labels: string[];
    queries: SchemaDeleteRef[];
    sequences: SchemaDeleteRef[];
    step_labels: string[];
    execution_packages: Array<{ id: string; status: string }>;
    dependent_schemas: string[];
  };
  warnings: SchemaDeleteWarning[];
}

export interface SchemaDeleteResult {
  space_id: string;
  attributive_label: string;
  purged: boolean;
  unlinked_labels: string[];
  warnings: SchemaDeleteWarning[];
  entities_deleted?: number;
  catalog?: { queries_deleted: number; state_deleted: number };
  graph?: { nodes_deleted: number };
}

/** Dry-run the SCHEMA delete cascade: returns the blast radius and warnings (no writes). */
export async function previewSchemaDeletion(
  spaceId: string,
  attributiveLabel: string
): Promise<SchemaDeletePreview> {
  return postJson<SchemaDeletePreview>(
    "/api/schema/delete/preview",
    { space_id: spaceId, attributive_label: attributiveLabel },
    "Failed to preview schema deletion"
  );
}

/** Execute the SCHEMA delete cascade after the user confirms the preview. */
export async function executeSchemaDeletion(
  spaceId: string,
  attributiveLabel: string
): Promise<SchemaDeleteResult> {
  return postJson<SchemaDeleteResult>(
    "/api/schema/delete",
    { space_id: spaceId, attributive_label: attributiveLabel, confirm: true },
    "Failed to delete schema"
  );
}

export interface StepDeletePreview {
  space_id: string;
  attributive_label: string;
  requires_confirmation: boolean;
  summary: {
    relationship_patterns: number;
    sequences: number;
    execution_packages: number;
  };
  affected: {
    labels: string[];
    relationship_labels: string[];
    sequences: SchemaDeleteRef[];
    execution_packages: Array<{ id: string; status: string }>;
  };
  warnings: SchemaDeleteWarning[];
}

export interface StepDeleteResult {
  space_id: string;
  attributive_label: string;
  purged: boolean;
  unlinked_labels: string[];
  warnings: SchemaDeleteWarning[];
  entities_deleted?: number;
  catalog?: { queries_deleted: number; state_deleted: number };
  graph?: { nodes_deleted: number };
}

/** Dry-run the STEP delete cascade: returns the blast radius and warnings (no writes). */
export async function previewStepDeletion(
  spaceId: string,
  attributiveLabel: string
): Promise<StepDeletePreview> {
  return postJson<StepDeletePreview>(
    "/api/step/delete/preview",
    { space_id: spaceId, attributive_label: attributiveLabel },
    "Failed to preview step deletion"
  );
}

/** Execute the STEP delete cascade after the user confirms the preview. */
export async function executeStepDeletion(
  spaceId: string,
  attributiveLabel: string
): Promise<StepDeleteResult> {
  return postJson<StepDeleteResult>(
    "/api/step/delete",
    { space_id: spaceId, attributive_label: attributiveLabel, confirm: true },
    "Failed to delete step"
  );
}

export interface OperationDeletePreview {
  space_id: string;
  operation_id: string;
  operation_name: string;
  attributive_label: string;
  requires_confirmation: boolean;
  one_step_sequences: Array<{ id: string; name: string }>;
  multi_step_sequences: Array<{ id: string; name: string }>;
  summary: {
    one_step_sequences: number;
    multi_step_sequences: number;
    execution_packages: number;
  };
}

export interface OperationDeleteResult {
  space_id: string;
  operation_id: string;
  attributive_label: string;
  one_step_deleted: string[];
  multi_step_suspended: string[];
  entities_deleted?: number;
  catalog?: { queries_deleted: number; state_deleted: number };
  graph?: { nodes_deleted: number };
}

export async function previewOperationDeletion(
  spaceId: string,
  opts: { operationId?: string; sequenceId?: string }
): Promise<OperationDeletePreview> {
  return postJson<OperationDeletePreview>(
    "/api/operation/delete/preview",
    {
      space_id: spaceId,
      operation_id: opts.operationId || "",
      sequence_id: opts.sequenceId || ""
    },
    "Failed to preview operation deletion"
  );
}

export async function executeOperationDeletion(
  spaceId: string,
  opts: { operationId?: string; sequenceId?: string }
): Promise<OperationDeleteResult> {
  return postJson<OperationDeleteResult>(
    "/api/operation/delete",
    {
      space_id: spaceId,
      operation_id: opts.operationId || "",
      sequence_id: opts.sequenceId || "",
      confirm: true
    },
    "Failed to delete operation"
  );
}

// A sequence read query matches its initial STEP node by attributive_label, e.g.
//   MATCH (alias:STEP { attributive_label: 'STEP_LABEL' }) RETURN *
const STEP_ATTR_LABEL_RE = /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/i;

function statementsOf(cypher: string[] | string | undefined): string[] {
  if (typeof cypher === "string") return cypher.trim() ? [cypher] : [];
  if (!Array.isArray(cypher)) return [];
  return cypher.map((statement) => String(statement ?? ""));
}

function parseSequenceAttributiveLabel(cypher: string[] | string | undefined): string {
  for (const statement of statementsOf(cypher)) {
    const match = STEP_ATTR_LABEL_RE.exec(statement);
    if (match) return match[1].trim();
  }
  return "";
}

export async function fetchSequences(): Promise<SequenceSummary[]> {
  const data = await getJson<QueriesResponse>("/api/queries", "Failed to load sequences");
  return (data.queries || []).map((query, index) => {
    const kind =
      query.kind === "system" || query.kind === "sequence" || query.kind === "operation"
        ? query.kind
        : "operation";
    const parsedLabel = parseSequenceAttributiveLabel(query.cypher);
    // One-step wraps are named after the wrapping STEP. If Cypher parsing misses
    // (string vs array), fall back to the catalog name so a just-created wrap is
    // not treated as having no entry STEP.
    const attributiveLabel =
      parsedLabel ||
      (kind === "sequence" && Boolean(query.single_step) ? String(query.name || "").trim() : "");
    return {
      id: query.id || `sequence-${index + 1}`,
      label: query.name || query.id || `Sequence ${index + 1}`,
      kind,
      attributiveLabel,
      runtimeEnabled: Boolean(query.runtime_enabled),
      suspended: Boolean(query.suspended),
      orphaned: false,
      groupTitle: query.group_title?.trim() || null,
      sortOrder: typeof query.sort_order === "number" ? query.sort_order : null,
      description: typeof query.description === "string" ? query.description : "",
      singleStep: Boolean(query.single_step)
    };
  });
}

/** attributive_labels of STEP nodes that currently exist in the space's graph. */
export async function fetchStepAttributiveLabels(spaceId: string): Promise<Set<string>> {
  const data = await getJson<{ nodes?: Array<{ attributive_label?: string }> }>(
    `/api/graph/nodes-by-label?space_id=${encodeURIComponent(spaceId)}&node_label=STEP`,
    "Failed to load step nodes",
    { cache: "no-store" }
  );
  const labels = new Set<string>();
  for (const node of data.nodes || []) {
    const label = String(node.attributive_label || "").trim();
    if (label) labels.add(label);
  }
  return labels;
}

/**
 * A sequence is orphaned when its read query names an entry STEP that is not in the graph
 * (`stepLabels` null means the graph could not be read — leave flags unset).
 */
export function markOrphanedSequences(
  sequences: SequenceSummary[],
  stepLabels: Set<string> | null
): SequenceSummary[] {
  if (!stepLabels) {
    return sequences.map((sequence) => ({ ...sequence, orphaned: false }));
  }
  return sequences.map((sequence) => {
    if (sequence.kind !== "sequence") return { ...sequence, orphaned: false };
    const label = sequence.attributiveLabel.trim();
    // An empty label means the MATCH could not be parsed — that is not the same as
    // "the STEP is missing from the graph", and treating it as orphaned paints
    // freshly wrapped one-step sequences red.
    if (!label) return { ...sequence, orphaned: false };
    return { ...sequence, orphaned: !stepLabels.has(label) };
  });
}

/** Catalog sequences annotated with whether their entry STEP still exists in this space. */
export async function fetchNavSequences(spaceId: string): Promise<SequenceSummary[]> {
  const [sequences, stepLabels] = await Promise.all([
    fetchSequences(),
    fetchStepAttributiveLabels(spaceId).catch(() => null)
  ]);
  return markOrphanedSequences(sequences, stepLabels);
}

/**
 * Remove only a sequence's definition (its catalog row + composed state packages), leaving the
 * underlying STEP nodes / graph patterns intact. This is the "remove from the nav" delete; the
 * cascading variant is `executeStepDeletion`.
 */
export async function deleteSequenceDefinition(
  spaceId: string,
  sequenceId: string
): Promise<{ id: string; queries_deleted: number; state_deleted: number }> {
  const data = await postJson<{
    id?: string;
    queries_deleted?: number;
    state_deleted?: number;
  }>(
    "/api/sequence/delete",
    { id: sequenceId, space_id: spaceId },
    "Failed to remove sequence"
  );
  return {
    id: data.id ?? sequenceId,
    queries_deleted: data.queries_deleted ?? 0,
    state_deleted: data.state_deleted ?? 0
  };
}

/** Update only a saved sequence's description (post-hoc edit; never touches its package). */
export async function updateSequenceDescription(
  spaceId: string,
  sequenceId: string,
  description: string
): Promise<{ id: string; description: string }> {
  const data = await postJson<{ id?: string; description?: string }>(
    `/api/queries/${encodeURIComponent(sequenceId)}/description`,
    { space_id: spaceId, description },
    "Failed to update description"
  );
  return { id: data.id ?? sequenceId, description: data.description ?? description };
}

export interface SequenceReorderItem {
  id: string;
  groupTitle: string | null;
  sortOrder: number;
}

/** Persist the nav-bar drag ordering (sort_order + group_title) for sequences. */
export async function reorderSequences(items: SequenceReorderItem[]): Promise<void> {
  await postJson<unknown>(
    "/api/queries/reorder",
    {
      items: items.map((item) => ({
        id: item.id,
        group_title: item.groupTitle,
        sort_order: item.sortOrder
      }))
    },
    "Failed to save sequence order"
  );
}

/** One shared implementation with the builder packages (see @pona-flow/connector). */
export async function fetchSpaceGroups(spaceId: string): Promise<string[]> {
  return connectorFetchSpaceGroups(spaceId);
}

export type NavSection = "sequences" | "events" | "consoles";

export async function fetchNavGroups(spaceId: string): Promise<{
  groups: string[];
  eventGroups: string[];
  consoleGroups: string[];
}> {
  const data = await getJson<{
    groups?: string[];
    event_groups?: string[];
    console_groups?: string[];
  }>(
    `/api/space/groups?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load groups",
    { cache: "no-store" }
  );
  return {
    groups: Array.isArray(data.groups) ? data.groups : [],
    eventGroups: Array.isArray(data.event_groups) ? data.event_groups : [],
    consoleGroups: Array.isArray(data.console_groups) ? data.console_groups : []
  };
}

/** Replace the ordered group-title list for one nav section (add / reorder / delete). */
export async function setSpaceGroups(
  spaceId: string,
  groups: string[],
  section: NavSection = "sequences"
): Promise<void> {
  await postJson<unknown>(
    "/api/space/groups",
    { space_id: spaceId, groups, section },
    "Failed to save groups"
  );
}

export interface NavReorderItem {
  id: string;
  groupTitle: string | null;
  sortOrder: number;
}

async function reorderNavRows(path: string, items: NavReorderItem[], label: string): Promise<void> {
  await postJson<unknown>(
    path,
    {
      items: items.map((item) => ({
        id: item.id,
        group_title: item.groupTitle,
        sort_order: item.sortOrder
      }))
    },
    label
  );
}

export function reorderEvents(items: NavReorderItem[]): Promise<void> {
  return reorderNavRows("/api/events/reorder", items, "Failed to save event order");
}

export function reorderConsoles(items: NavReorderItem[]): Promise<void> {
  return reorderNavRows("/api/consoles/reorder", items, "Failed to save console order");
}

/** Run a saved sequence's stored read cypher and return the visualization result. */
export async function runSequenceQuery(
  sequenceId: string,
  spaceId: string,
  params: Record<string, unknown> = {}
): Promise<RunResult | null> {
  const data = await getJson<QueriesResponse>("/api/queries", "Failed to load sequence query");
  const query = (data.queries || []).find((entry) => entry.id === sequenceId);
  const cypher = statementsOf(query?.cypher).filter((statement) => statement.trim());
  if (!query || cypher.length === 0) {
    return null;
  }
  return runReadCypher(spaceId, cypher, params);
}

export interface ExecutionStepParameter {
  name: string;
  is_required: boolean;
  value_type: string;
  format?: string;
  default_value?: unknown;
  /** radio + checkbox: choices the runner picks from. */
  options?: string[];
  /** checkbox: minimum number of choices that must be selected. */
  min_choices?: number;
  /** checkbox: maximum number of choices that may be selected. */
  max_choices?: number;
  /** Minted by the executor (create-INSTANCE graph ids); never a caller-supplied input. */
  auto_generate?: boolean;
}

export interface ExecutionStepTransition {
  id: string;
  condition_parameter: string;
}

export interface ExecutionStep {
  id: string;
  query_id: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, unknown>;
  body: Record<string, unknown>;
  parameters?: ExecutionStepParameter[];
  next: ExecutionStepTransition[];
}

export interface ExecutionResponseParameter {
  property_path: string;
  parameter: string;
  default_value?: string;
}

/**
 * The names one step publishes into run state — an operation-backed step's RETURN
 * aliases, or the parameters an endpoint/code/LLM step's response mappings write.
 * Compose-time introspection: it is what a loop condition or for-each source may
 * reference, and what the builder's loop pickers offer.
 */
export interface ExecutionAvailableParameters {
  step_id: string;
  label?: string;
  aliases: string[];
}

/**
 * How the sequence's one cycle terminates. Absent for a plain DAG walk, where a
 * transition back to an earlier step simply ends the run.
 */
export interface ExecutionLoop {
  type: "for" | "for_while" | "for_each";
  max_iterations: number;
  back_edge: { from: string; to: string };
  body: string[];
  count?: number;
  condition?: { parameter: string; operator: string; value: string };
  source?: string;
  source_step?: string;
}

export interface ExecutionPackage {
  steps: ExecutionStep[];
  response_parameters?: ExecutionResponseParameter[];
  available_parameters?: ExecutionAvailableParameters[];
  parameter_values?: Record<string, unknown>;
  loop?: ExecutionLoop;
}

export interface ComposedSequence {
  state_id: string;
  package: ExecutionPackage;
}

/**
 * Compose a sequence's EXECUTION package on the backend and persist it as an
 * inactive `state` row. Runs when a sequence is highlighted in the nav bar.
 * Throws with the server's error message on failure so callers can surface it.
 */
export async function composeSequence(
  sequenceId: string,
  spaceId: string
): Promise<ComposedSequence> {
  return postJson<ComposedSequence>(
    "/api/sequence/compose",
    { space_id: spaceId, query_id: sequenceId },
    (response, data) => data.detail || `Failed to compose sequence (${response.status})`
  );
}

export async function previewSequenceParameters(
  opts: {
    spaceId: string;
    sequenceId?: string;
    entryStep?: string;
    traversal?: "single" | "downstream";
  }
): Promise<{
  parameters: ExecutionStepParameter[];
  parameter_values: Record<string, unknown>;
  /** STEP parameter lists in run order, before caller-facing filtering. */
  parameter_steps?: ExecutionStepParameter[][];
  /** Names produced by an earlier step, so a caller does not supply them. */
  response_parameter_names?: string[];
}> {
  return postJson(
    "/api/sequence/preview-parameters",
    {
      space_id: opts.spaceId,
      sequence_id: opts.sequenceId,
      entry_step: opts.entryStep,
      traversal: opts.traversal
    },
    (response, data) => data.detail || `Failed to preview sequence parameters (${response.status})`
  );
}

export async function fetchSequenceDefinition(
  sequenceId: string,
  spaceId: string
): Promise<SequenceDefinition> {
  const [queriesData, stepFlowData] = await Promise.all([
    getJson<QueriesResponse>("/api/queries", "Failed to load sequence definition"),
    getJson<{
      step_graph?: {
        nodes?: Array<{ id?: string; attributive_label?: string; payload?: Record<string, unknown> }>;
        relationships?: Array<{
          id?: string;
          source?: string;
          target?: string;
          type?: string;
          attributive_label?: string;
          payload?: Record<string, unknown>;
        }>;
      };
      affected_query_ids?: string[];
      affected_step_labels?: string[];
    }>(
      `/api/graph/step-flow?space_id=${encodeURIComponent(spaceId)}&query_id=${encodeURIComponent(sequenceId)}`,
      "Failed to load step flow graph"
    )
  ]);

  const query = (queriesData.queries || []).find((entry) => entry.id === sequenceId);
  if (!query) {
    throw new Error("Sequence not found");
  }

  const rawGraph = stepFlowData.step_graph ?? { nodes: [], relationships: [] };

  return {
    id: sequenceId,
    label: query.name || sequenceId,
    // Parameter handling is being migrated to the execution-package composer/executor.
    parameterSchema: [],
    stepGraph: {
      nodes: (rawGraph.nodes ?? [])
        .map((node) => ({
          id: node.id ?? "",
          attributive_label: node.attributive_label ?? "",
          payload: node.payload ?? {}
        }))
        .filter((node) => node.id && node.attributive_label),
      relationships: (rawGraph.relationships ?? [])
        .map((rel) => ({
          id: rel.id ?? "",
          source: rel.source ?? "",
          target: rel.target ?? "",
          type: rel.type ?? "POINTS_TO",
          attributive_label: rel.attributive_label ?? "",
          payload: rel.payload ?? {}
        }))
        .filter((rel) => rel.id && rel.source && rel.target && rel.attributive_label)
    },
    affectedQueryIds: (stepFlowData.affected_query_ids ?? [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id.length > 0),
    affectedStepLabels: (stepFlowData.affected_step_labels ?? [])
      .map((label) => String(label ?? "").trim())
      .filter((label) => label.length > 0)
  };
}

export interface ExecutionRunStep {
  step_id: string;
  query_id: string;
  endpoint: string;
}

export type ExecutionFinalResult =
  | {
      kind: "graph";
      graph: GraphPayload;
      columns: string[];
      rows: Array<Record<string, unknown>>;
    }
  | { kind: "table"; columns: string[]; rows: Array<Record<string, unknown>> }
  | {
      kind: "response";
      response: string;
      status?: number;
      ok?: boolean;
      error?: string;
    };

export type ExecutionRunResult =
  | {
      status: "pending";
      state_id: string;
      step_id: string;
      parameters: ExecutionStepParameter[];
      resolved: Record<string, unknown>;
    }
  | {
      status: "waiting";
      state_id: string;
      reason?: string;
      wake_at?: string;
      event_id?: string;
      step_id?: string;
    }
  | {
      status: "cancelled";
      state_id?: string;
      message?: string;
      stopped?: string[];
    }
  | {
      status: "cancelling";
      state_id?: string;
      stopped?: string[];
    }
  | {
      status: "inactive";
      state_id: string;
      resolved: Record<string, unknown>;
      executed: ExecutionRunStep[];
      final_result: ExecutionFinalResult | null;
    }
  | { status: "error"; message: string };

export interface InFlightRun {
  state_id: string;
  sequence_id: string;
  status: "active" | "pending" | "waiting";
  reason?: string | null;
  wake_at?: string | null;
  event_id?: string | null;
  step_id?: string | null;
}

/**
 * Run (or resume) a composed sequence's EXECUTION package via the backend
 * executor. A `pending` result means a step needs human-supplied parameters;
 * resubmit with the same `state_id` once the user fills them in.
 *
 * Hand-rolled (not `postJson`): a failed run is reported as an error-shaped
 * result rather than a thrown exception.
 */
export async function runSequenceExecution(
  spaceId: string,
  stateId: string,
  params: Record<string, unknown>
): Promise<ExecutionRunResult> {
  const response = await fetch("/api/sequence/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id: spaceId, state_id: stateId, params })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: "error", message: data.error || "Sequence run failed" };
  }
  return (await response.json()) as ExecutionRunResult;
}

export async function fetchInFlightRuns(spaceId: string): Promise<InFlightRun[]> {
  const data = await getJson<{ runs?: InFlightRun[] }>(
    `/api/sequence/in-flight?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load in-flight sequences"
  );
  return data.runs || [];
}

export async function fetchSequenceStatus(stateId: string): Promise<ExecutionRunResult> {
  const response = await fetch(
    `/api/sequence/status?state_id=${encodeURIComponent(stateId)}`
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: "error", message: data.error || "Failed to load sequence status" };
  }
  return (await response.json()) as ExecutionRunResult;
}

export async function stopSequenceExecution(
  spaceId: string,
  args: { stateId?: string; sequenceId?: string }
): Promise<ExecutionRunResult> {
  const response = await fetch("/api/sequence/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: spaceId,
      state_id: args.stateId || "",
      sequence_id: args.sequenceId || ""
    })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 404) {
      const detail = (data.error || "").trim();
      return {
        status: "error",
        message:
          detail.toLowerCase() === "state not found"
            ? "state not found"
            : "Stop is not available on this engine. Restart the Python API and try again."
      };
    }
    return { status: "error", message: data.error || "Failed to stop sequence" };
  }
  return (await response.json()) as ExecutionRunResult;
}

// ----- events (triggers) ----------------------------------------------------

interface EventApiRow {
  id?: string;
  space_id?: string;
  name?: string;
  type?: string;
  enabled?: number | boolean;
  event_package?: EventPackage;
  external_package?: ExternalPackage;
  simulation_package?: SimulationPackage;
  sequences?: string[];
  recovery_sequences?: string[];
  timers?: { next_fire_at?: string | null; last_fired_at?: string | null };
  group_title?: string | null;
  sort_order?: number | null;
}

function emptyExternalPackage(): ExternalPackage {
  return { combinator: "AND", filters: [], param_mappings: [], parameters: {} };
}

function toGroupTitle(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toSortOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toEventSummary(row: EventApiRow): EventSummary {
  return {
    id: row.id || "",
    name: row.name || row.id || "Untitled event",
    type: row.type || "time",
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    sequences: Array.isArray(row.sequences) ? row.sequences : [],
    recoverySequences: Array.isArray(row.recovery_sequences) ? row.recovery_sequences : [],
    groupTitle: toGroupTitle(row.group_title),
    sortOrder: toSortOrder(row.sort_order)
  };
}

export async function fetchEvents(spaceId: string): Promise<EventSummary[]> {
  const data = await getJson<{ events?: EventApiRow[] }>(
    `/api/events?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load events",
    { cache: "no-store" }
  );
  return (data.events || []).map(toEventSummary);
}

export async function fetchEvent(eventId: string): Promise<EventDetail> {
  const data = await getJson<EventApiRow>(
    `/api/events/${encodeURIComponent(eventId)}`,
    "Failed to load event",
    { cache: "no-store" }
  );
  return {
    ...toEventSummary(data),
    spaceId: data.space_id || "",
    eventPackage:
      (data.event_package as EventPackage) || { combinator: "OR", groups: [], parameters: {} },
    externalPackage: {
      ...emptyExternalPackage(),
      ...((data.external_package as ExternalPackage) || {})
    },
    simulationPackage: (data.simulation_package as SimulationPackage) || {
      tic_unit: "minutes",
      tic_duration: 15,
      sequence_id: "",
      probabilities: []
    },
    timers: data.timers || {}
  };
}

export interface SaveEventInput {
  id: string;
  spaceId: string;
  name: string;
  enabled: boolean;
  eventPackage: EventPackage;
  externalPackage?: ExternalPackage;
  simulationPackage?: SimulationPackage;
  sequences: string[];
  recoverySequences: string[];
  type?: string;
}

export async function saveEvent(
  input: SaveEventInput
): Promise<{ id: string; ingest_token?: string; simulation_token?: string }> {
  const data = await postJson<{ id?: string; ingest_token?: string; simulation_token?: string }>(
    "/api/events/upsert",
    {
      id: input.id,
      space_id: input.spaceId,
      name: input.name,
      enabled: input.enabled,
      type: input.type || "time",
      event_package: input.eventPackage,
      external_package: input.externalPackage,
      simulation_package: input.simulationPackage,
      sequences: input.sequences,
      recovery_sequences: input.recoverySequences
    },
    "Failed to save event"
  );
  return {
    id: data.id ?? input.id,
    ingest_token: data.ingest_token,
    simulation_token: data.simulation_token
  };
}

export async function deleteEvent(eventId: string): Promise<{ id: string }> {
  const data = await postJson<{ id?: string }>(
    "/api/events/delete",
    { id: eventId },
    "Failed to delete event"
  );
  return { id: data.id ?? eventId };
}

// ----- consoles -------------------------------------------------------------

export interface ConsoleSummary {
  id: string;
  name: string;
  triggerKind: "" | "url" | "event";
  listenUrl: string;
  triggerEventId: string;
  groupTitle: string | null;
  sortOrder: number | null;
}

export interface ConsoleDetail extends Omit<ConsoleSummary, "groupTitle" | "sortOrder"> {
  spaceId: string;
  document: { views: unknown[]; activeViewId: string };
}

interface ConsoleApiRow {
  id?: string;
  space_id?: string;
  name?: string;
  trigger_kind?: string;
  listen_url?: string;
  trigger_event_id?: string;
  document?: { views?: unknown[]; activeViewId?: string };
  group_title?: string | null;
  sort_order?: number | null;
}

function toConsoleSummary(row: ConsoleApiRow): ConsoleSummary {
  const kind = row.trigger_kind;
  return {
    id: row.id || "",
    name: row.name || "Console",
    triggerKind: kind === "url" || kind === "event" ? kind : "",
    listenUrl: row.listen_url || "",
    triggerEventId: row.trigger_event_id || "",
    groupTitle: toGroupTitle(row.group_title),
    sortOrder: toSortOrder(row.sort_order)
  };
}

export async function fetchConsoles(spaceId: string): Promise<ConsoleSummary[]> {
  const data = await getJson<{ consoles?: ConsoleApiRow[] }>(
    `/api/consoles?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load consoles",
    { cache: "no-store" }
  );
  return (data.consoles || []).map(toConsoleSummary);
}

export async function fetchConsole(consoleId: string): Promise<ConsoleApiRow> {
  return getJson<ConsoleApiRow>(
    `/api/consoles/${encodeURIComponent(consoleId)}`,
    "Failed to load console",
    { cache: "no-store" }
  );
}

export async function saveConsole(input: ConsoleDetail): Promise<{ id: string }> {
  const data = await postJson<{ id?: string }>(
    "/api/consoles/upsert",
    {
      id: input.id,
      space_id: input.spaceId,
      name: input.name,
      trigger_kind: input.triggerKind,
      listen_url: input.listenUrl,
      trigger_event_id: input.triggerEventId,
      document: input.document
    },
    "Failed to save console"
  );
  return { id: data.id ?? input.id };
}

export async function deleteConsole(consoleId: string): Promise<{ id: string }> {
  const data = await postJson<{ id?: string }>(
    "/api/consoles/delete",
    { id: consoleId },
    "Failed to delete console"
  );
  return { id: data.id ?? consoleId };
}

export type ConsoleSequenceOutcome =
  | { status: "inactive"; final_result: unknown }
  | {
      status: "pending";
      state_id: string;
      step_id: string;
      parameters: ExecutionStepParameter[];
    };

export async function runConsoleSequenceOutcome(input: {
  consoleId: string;
  sequenceId: string;
  viewId: string;
  role: "data" | "action";
  params: Record<string, unknown>;
  stateId?: string;
}): Promise<ConsoleSequenceOutcome> {
  const data = await postJson<ConsoleSequenceOutcome>(
    `/api/consoles/${encodeURIComponent(input.consoleId)}/run`,
    {
      sequenceId: input.sequenceId,
      viewId: input.viewId,
      role: input.role,
      params: input.params,
      stateId: input.stateId
    },
    (_response, body) =>
      (typeof body.detail === "string" && body.detail) || body.error || "Failed to run sequence"
  );
  if (data.status === "pending") return data;
  return { status: "inactive", final_result: data.final_result };
}

export async function runConsoleSequence(input: {
  consoleId: string;
  sequenceId: string;
  viewId: string;
  role: "data" | "action";
  params: Record<string, unknown>;
}): Promise<unknown> {
  const outcome = await runConsoleSequenceOutcome(input);
  if (outcome.status === "pending") {
    throw new Error("sequence is waiting for parameters");
  }
  return outcome.final_result;
}

export interface SimulationEmission {
  id: string;
  probabilityId: string;
  probabilityName: string;
  tic: number;
  worldTime: string;
  outcome: Record<string, unknown> | null;
  cancelled: boolean;
  runStatus: string | null;
}

export interface SimulationSession {
  id: string;
  eventId: string;
  status: "running" | "error";
  currentTic: number;
  worldStartAt: string;
  currentWorldTime: string;
  createdAt: string;
  errorMessage: string | null;
  /** Set only when the user has renamed the session. Otherwise the start time is the name. */
  name: string | null;
  emissions?: SimulationEmission[];
  /** Present on a tic response when the simulated event has a console. */
  consoleId?: string;
}

interface SimulationEmissionRow {
  id?: string;
  probability_id?: string;
  probability_name?: string;
  tic?: number;
  world_time?: string;
  outcome?: Record<string, unknown> | null;
  cancelled?: boolean;
  run_status?: string | null;
}

interface SimulationSessionRow {
  id?: string;
  event_id?: string;
  status?: "running" | "error";
  current_tic?: number;
  world_start_at?: string;
  current_world_time?: string;
  created_at?: string;
  error_message?: string | null;
  name?: string | null;
  emissions?: SimulationEmissionRow[];
  console_id?: string;
}

function toSimulationEmission(row: SimulationEmissionRow): SimulationEmission {
  return {
    id: row.id || "",
    probabilityId: row.probability_id || "",
    probabilityName: row.probability_name || "",
    tic: row.tic ?? 0,
    worldTime: row.world_time || "",
    outcome: row.outcome ?? null,
    cancelled: Boolean(row.cancelled),
    runStatus: row.run_status ?? null
  };
}

function toSimulationSession(row: SimulationSessionRow): SimulationSession {
  return {
    id: row.id || "",
    eventId: row.event_id || "",
    status: row.status === "error" ? "error" : "running",
    currentTic: row.current_tic ?? 0,
    worldStartAt: row.world_start_at || "",
    currentWorldTime: row.current_world_time || "",
    createdAt: row.created_at || "",
    errorMessage: row.error_message ?? null,
    name: row.name?.trim() || null,
    emissions: Array.isArray(row.emissions) ? row.emissions.map(toSimulationEmission) : undefined,
    consoleId: row.console_id || undefined
  };
}

export async function fetchSimulationSessions(eventId: string): Promise<SimulationSession[]> {
  const data = await getJson<{ sessions?: SimulationSessionRow[] }>(
    `/api/events/${encodeURIComponent(eventId)}/sessions`,
    "Failed to load simulation sessions",
    { cache: "no-store" }
  );
  return (data.sessions || []).map(toSimulationSession);
}

export async function fetchSimulationSession(
  eventId: string,
  sessionId: string
): Promise<SimulationSession> {
  const data = await getJson<SimulationSessionRow>(
    `/api/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}`,
    "Failed to load simulation session",
    { cache: "no-store" }
  );
  return toSimulationSession(data);
}

export async function createSimulationSession(
  eventId: string,
  worldStartAt: string
): Promise<SimulationSession> {
  const data = await postJson<SimulationSessionRow>(
    `/api/events/${encodeURIComponent(eventId)}/sessions`,
    { world_start_at: worldStartAt },
    "Failed to create simulation session"
  );
  return toSimulationSession(data);
}

export async function advanceSimulationSession(
  eventId: string,
  sessionId: string
): Promise<SimulationSession> {
  const data = await postJson<SimulationSessionRow>(
    `/api/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}/tic`,
    {},
    "Failed to advance simulation session"
  );
  return toSimulationSession(data);
}

export async function clearSimulationSessionError(
  eventId: string,
  sessionId: string
): Promise<SimulationSession> {
  const data = await postJson<SimulationSessionRow>(
    `/api/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}/clear-error`,
    {},
    "Failed to clear simulation error"
  );
  return toSimulationSession(data);
}

export async function renameSimulationSession(
  eventId: string,
  sessionId: string,
  name: string
): Promise<SimulationSession> {
  const data = await postJson<SimulationSessionRow>(
    `/api/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}/name`,
    { name },
    "Failed to rename simulation session"
  );
  return toSimulationSession(data);
}

export async function deleteSimulationSession(eventId: string, sessionId: string): Promise<void> {
  await deleteJson(
    `/api/events/${encodeURIComponent(eventId)}/sessions/${encodeURIComponent(sessionId)}`,
    "Failed to delete simulation session"
  );
}

/** Latest body captured by an external event's test endpoint. */
export interface EventTestCapture {
  receivedAt: string;
  contentType: string | null;
  payload: unknown;
}

export async function fetchEventTestCapture(eventId: string): Promise<EventTestCapture | null> {
  const data = await getJson<{
    capture?: {
      received_at?: string;
      content_type?: string | null;
      payload?: unknown;
    } | null;
  }>(
    `/api/events/${encodeURIComponent(eventId)}/test-capture`,
    "Failed to listen for a test payload",
    { cache: "no-store" }
  );
  const capture = data.capture;
  if (!capture) return null;
  return {
    receivedAt: capture.received_at || "",
    contentType: capture.content_type ?? null,
    payload: capture.payload ?? {}
  };
}

export async function clearEventTestCapture(eventId: string): Promise<void> {
  await deleteJson(
    `/api/events/${encodeURIComponent(eventId)}/test-capture`,
    "Failed to clear the test payload"
  );
}

export async function fetchAuditLog(spaceId: string, limit = 200): Promise<AuditEntry[]> {
  const data = await getJson<{
    entries?: Array<{
      id?: string;
      run_at?: string;
      sequence_ids?: string[];
      event_id?: string | null;
      trigger?: string;
      principal_id?: string | null;
      principal_email?: string | null;
      parameter_map?: Record<string, unknown> | null;
    }>;
  }>(
    `/api/audit-log?space_id=${encodeURIComponent(spaceId)}&limit=${encodeURIComponent(String(limit))}`,
    "Failed to load audit log",
    { cache: "no-store" }
  );
  return (data.entries || []).map((entry) => ({
    id: entry.id || "",
    runAt: entry.run_at || "",
    sequenceIds: Array.isArray(entry.sequence_ids) ? entry.sequence_ids : [],
    eventId: entry.event_id ?? null,
    trigger: entry.trigger || "manual",
    principalId: entry.principal_id ?? null,
    principalEmail: entry.principal_email ?? null,
    parameterMap:
      entry.parameter_map && typeof entry.parameter_map === "object" && !Array.isArray(entry.parameter_map)
        ? entry.parameter_map
        : null
  }));
}

/** One shared implementation with the builder packages (see @pona-flow/connector). */
export async function generateId(): Promise<string> {
  return fetchGeneratedId();
}

// ----- RBAC: principal, permissions, members, roles -------------------------

export interface RolePermissions {
  flows: string[];
  sequences: { all: boolean; ids: string[] };
  manageSpace: boolean;
}

export interface SpaceRole {
  id: string;
  name: string;
  permissions: RolePermissions;
  isDefault: boolean;
}

export interface SpaceMember {
  id: string;
  principalId: string | null;
  email: string | null;
  name: string | null;
  principalType: string | null;
  roleId: string | null;
  roleName: string | null;
  isOwner: boolean;
  permissionsOverride: RolePermissions | null;
  status: string;
}

export interface PrincipalRow {
  id: string;
  email: string | null;
  name: string | null;
  principalType: string;
  canCreateSpaces: boolean;
  isInstanceAdmin: boolean;
}

interface PermsApi {
  flows?: string[];
  sequences?: { all?: boolean; ids?: string[] };
  manage_space?: boolean;
}

function toPerms(p: PermsApi | undefined | null): RolePermissions {
  return {
    flows: Array.isArray(p?.flows) ? (p?.flows as string[]) : [],
    sequences: {
      all: Boolean(p?.sequences?.all),
      ids: Array.isArray(p?.sequences?.ids) ? (p?.sequences?.ids as string[]) : []
    },
    manageSpace: Boolean(p?.manage_space)
  };
}

/** Serialize UI permissions back to the API's snake_case shape. */
export function permsToApi(p: RolePermissions): PermsApi {
  return {
    flows: p.flows,
    sequences: { all: p.sequences.all, ids: p.sequences.ids },
    manage_space: p.manageSpace
  };
}

/** Raw `/api/me` payload shape (also returned by the built-in auth routes on sign-in). */
export type MePayload = {
  principal_id?: string;
  email?: string | null;
  display_name?: string | null;
  principal_type?: string;
  is_superadmin?: boolean;
  can_create_spaces?: boolean;
  timezone?: string | null;
  onboarding_tour_seen?: boolean;
  workbench_mode?: "chat" | "classic";
};

export function meFromPayload(data: MePayload): Me {
  return {
    principalId: data.principal_id || "",
    email: data.email ?? null,
    displayName: data.display_name ?? null,
    principalType: data.principal_type || "user",
    isSuperadmin: Boolean(data.is_superadmin),
    canCreateSpaces: Boolean(data.can_create_spaces),
    timezone: data.timezone ?? null,
    // Older servers omit the flag; treat that as "seen" so the tour never nags there.
    onboardingTourSeen: data.onboarding_tour_seen ?? true,
    workbenchMode: data.workbench_mode === "classic" ? "classic" : "chat"
  };
}

export async function fetchMe(): Promise<Me> {
  const data = await getJson<MePayload>("/api/me", "Failed to load principal", {
    cache: "no-store"
  });
  return meFromPayload(data);
}

export type InstanceUpdateCommit = {
  sha: string;
  message: string;
  date: string;
  url: string;
};

export type InstanceUpdateStatus = {
  repo: string;
  branch: string;
  current_sha: string;
  latest_sha: string;
  behind: boolean;
  up_to_date: boolean;
  commits: InstanceUpdateCommit[];
  can_update: boolean;
  update_method: "fly" | "manual";
  fly_token_configured: boolean;
  fly_app_name: string;
  image: string;
  manual_hint: string;
  /** Set when GitHub couldn't be read (e.g. rate limited); updating still works. */
  github_error: string | null;
  started_at: number;
};

export async function fetchInstanceUpdates(): Promise<InstanceUpdateStatus> {
  return getJson<InstanceUpdateStatus>(
    "/api/instance/updates",
    "Failed to load instance updates",
    { cache: "no-store" }
  );
}

export type InstanceVersion = { build_sha: string; started_at: number };

/** The running build — cheap, never calls GitHub; polled while an update restarts the app. */
export async function fetchInstanceVersion(): Promise<InstanceVersion> {
  return getJson<InstanceVersion>("/api/instance/version", "Failed to load instance version", {
    cache: "no-store"
  });
}

export async function saveInstanceUpdateCredentials(body: {
  fly_api_token?: string;
  fly_app_name?: string;
}): Promise<{ fly_token_configured: boolean; fly_app_name: string }> {
  return postJson(
    "/api/instance/updates/credentials",
    body,
    "Failed to save Fly deploy credentials"
  );
}

export async function applyInstanceUpdate(): Promise<{
  ok?: boolean;
  image?: string;
  machines?: string[];
}> {
  return postJson("/api/instance/updates/apply", {}, "Failed to start instance update");
}

/** Persist the signed-in principal's settings. Only the fields you pass are written. */
export async function updateMySettings(settings: {
  timezone?: string | null;
  workbenchMode?: "chat" | "classic";
}): Promise<{ timezone: string | null; workbenchMode: "chat" | "classic" }> {
  const body: { timezone?: string | null; workbench_mode?: "chat" | "classic" } = {};
  if ("timezone" in settings) body.timezone = settings.timezone ?? null;
  if (settings.workbenchMode) body.workbench_mode = settings.workbenchMode;
  const data = await postJson<{ timezone?: string | null; workbench_mode?: "chat" | "classic" }>(
    "/api/me/settings",
    body,
    "Failed to save settings"
  );
  return {
    timezone: data.timezone ?? null,
    workbenchMode: data.workbench_mode === "classic" ? "classic" : "chat"
  };
}

/** Mark the product tour finished/skipped (true) or reset it so it auto-starts again (false). */
export async function setOnboardingTourSeen(seen: boolean): Promise<void> {
  await postJson("/api/me/onboarding", { seen }, "Failed to save tour progress");
}

export async function fetchSpacePermissions(spaceId: string): Promise<SpacePermissions> {
  const data = await getJson<{ permissions?: PermsApi }>(
    `/api/space/permissions?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load permissions",
    { cache: "no-store" }
  );
  return toPerms(data.permissions);
}

export async function fetchSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
  const data = await getJson<{ members?: Array<Record<string, unknown>> }>(
    `/api/space/members?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load members",
    { cache: "no-store" }
  );
  return (data.members || []).map((m) => ({
    id: String(m.id || ""),
    principalId: (m.principal_id as string) ?? null,
    email: (m.email as string) ?? null,
    name: (m.name as string) ?? null,
    principalType: (m.principal_type as string) ?? null,
    roleId: (m.role_id as string) ?? null,
    roleName: (m.role_name as string) ?? null,
    isOwner: Boolean(m.is_owner),
    permissionsOverride: m.permissions_override ? toPerms(m.permissions_override as PermsApi) : null,
    status: String(m.status || "active")
  }));
}

export async function inviteMember(
  spaceId: string,
  email: string,
  roleId: string | null
): Promise<void> {
  await postJson<unknown>(
    "/api/space/members/invite",
    { space_id: spaceId, email, role_id: roleId },
    "Failed to invite member"
  );
}

export async function updateMember(
  spaceId: string,
  memberId: string,
  changes: { roleId?: string | null; permissionsOverride?: RolePermissions | null; isOwner?: boolean }
): Promise<void> {
  const body: Record<string, unknown> = { space_id: spaceId, member_id: memberId };
  if (changes.roleId !== undefined) body.role_id = changes.roleId;
  if (changes.isOwner !== undefined) body.is_owner = changes.isOwner;
  if (changes.permissionsOverride === null) body.clear_override = true;
  else if (changes.permissionsOverride !== undefined)
    body.permissions_override = permsToApi(changes.permissionsOverride);
  await postJson<unknown>("/api/space/members/update", body, "Failed to update member");
}

export async function removeMember(spaceId: string, memberId: string): Promise<void> {
  await postJson<unknown>(
    "/api/space/members/remove",
    { space_id: spaceId, member_id: memberId },
    "Failed to remove member"
  );
}

export async function fetchSpaceRoles(spaceId: string): Promise<SpaceRole[]> {
  const data = await getJson<{ roles?: Array<Record<string, unknown>> }>(
    `/api/space/roles?space_id=${encodeURIComponent(spaceId)}`,
    "Failed to load roles",
    { cache: "no-store" }
  );
  return (data.roles || []).map((r) => ({
    id: String(r.id || ""),
    name: String(r.name || ""),
    permissions: toPerms(r.permissions as PermsApi),
    isDefault: Boolean(r.is_default)
  }));
}

export async function upsertRole(
  spaceId: string,
  name: string,
  permissions: RolePermissions,
  roleId?: string
): Promise<void> {
  await postJson<unknown>(
    "/api/space/roles/upsert",
    { space_id: spaceId, id: roleId, name, permissions: permsToApi(permissions) },
    "Failed to save role"
  );
}

export async function deleteRole(spaceId: string, roleId: string): Promise<void> {
  await postJson<unknown>(
    "/api/space/roles/delete",
    { space_id: spaceId, role_id: roleId },
    "Failed to delete role"
  );
}

export async function fetchPrincipals(): Promise<PrincipalRow[]> {
  const data = await getJson<{ principals?: Array<Record<string, unknown>> }>(
    "/api/principals",
    "Failed to load principals",
    { cache: "no-store" }
  );
  return (data.principals || []).map((p) => ({
    id: String(p.id || ""),
    email: (p.email as string) ?? null,
    name: (p.name as string) ?? null,
    principalType: String(p.principal_type || "user"),
    canCreateSpaces: Boolean(p.can_create_spaces),
    isInstanceAdmin: Boolean(p.is_instance_admin)
  }));
}

export async function updatePrincipal(
  principalId: string,
  canCreateSpaces: boolean
): Promise<void> {
  await postJson<unknown>(
    "/api/principals/update",
    { principal_id: principalId, can_create_spaces: canCreateSpaces },
    "Failed to update principal"
  );
}

// ----- Agent API keys -------------------------------------------------------

export interface AgentKey {
  id: string;
  name: string;
  lastUsedDate: string | null;
  revoked: boolean;
  creationDate: string;
}

/** A freshly minted key. ``token`` is the plaintext secret, returned only once. */
export interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  roleId: string | null;
}

export async function fetchAgentKeys(spaceId: string): Promise<AgentKey[]> {
  const data = await getJson<{ keys?: Array<Record<string, unknown>> }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/agent-keys`,
    "Failed to load agent keys",
    { cache: "no-store" }
  );
  return (data.keys || []).map((k) => ({
    id: String(k.id || ""),
    name: String(k.name || ""),
    lastUsedDate: (k.last_used_date as string) ?? null,
    revoked: Boolean(k.revoked),
    creationDate: String(k.creation_date || "")
  }));
}

export async function createAgentKey(
  spaceId: string,
  name: string,
  roleId?: string | null
): Promise<CreatedAgentKey> {
  const data = await postJson<{
    id?: string;
    name?: string;
    token?: string;
    role_id?: string | null;
  }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/agent-keys`,
    { name, role_id: roleId || null },
    "Failed to create agent key"
  );
  return {
    id: String(data.id || ""),
    name: String(data.name || ""),
    token: String(data.token || ""),
    roleId: data.role_id ?? null
  };
}

export async function revokeAgentKey(spaceId: string, keyId: string): Promise<void> {
  await deleteJson<unknown>(
    `/api/spaces/${encodeURIComponent(spaceId)}/agent-keys/${encodeURIComponent(keyId)}`,
    "Failed to revoke agent key"
  );
}

// ----- Credentials ----------------------------------------------------------

/** Credential metadata. The secret value is never returned by the API. */
export interface Credential {
  id: string;
  name: string;
  envKey: string;
  description: string;
  backend: string;
  configured: boolean;
  creationDate: string;
  modifiedDate: string;
}

export interface CredentialList {
  /** Active store backend: "local" (writes .env) | "passthrough" | "hosted". */
  backend: string;
  credentials: Credential[];
}

function mapCredential(c: Record<string, unknown>): Credential {
  return {
    id: String(c.id || ""),
    name: String(c.name || ""),
    envKey: String(c.env_key || ""),
    description: String(c.description || ""),
    backend: String(c.backend || ""),
    configured: Boolean(c.configured),
    creationDate: String(c.creation_date || ""),
    modifiedDate: String(c.modified_date || "")
  };
}

export async function fetchCredentials(spaceId: string): Promise<CredentialList> {
  const data = await getJson<{
    backend?: string;
    credentials?: Array<Record<string, unknown>>;
  }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/credentials`,
    "Failed to load credentials",
    { cache: "no-store" }
  );
  return {
    backend: String(data.backend || ""),
    credentials: (data.credentials || []).map(mapCredential)
  };
}

export async function upsertCredential(
  spaceId: string,
  name: string,
  value?: string,
  description?: string
): Promise<Credential> {
  const body: Record<string, unknown> = { name };
  if (value !== undefined) body.value = value;
  if (description !== undefined) body.description = description;
  const data = await sendJson<Record<string, unknown>>(
    "PUT",
    `/api/spaces/${encodeURIComponent(spaceId)}/credentials`,
    body,
    "Failed to save credential"
  );
  return mapCredential(data);
}

export async function deleteCredential(spaceId: string, name: string): Promise<void> {
  await deleteJson<unknown>(
    `/api/spaces/${encodeURIComponent(spaceId)}/credentials/${encodeURIComponent(name)}`,
    "Failed to delete credential"
  );
}

// ----- Embeddings (Ollama or Gemini vector search) --------------------------

export type EmbeddingProvider = "ollama" | "gemini";

/** A space's vector-search settings. `dimensions` is probed from the model, never typed. */
export interface EmbeddingsConfig {
  enabled: boolean;
  provider: EmbeddingProvider;
  ollamaUrl: string;
  /** Gemini-compatible API root. Blank until a cloud provider is saved. */
  baseUrl: string;
  embedModel: string;
  /** Credential name for a cloud provider. Never the secret. */
  credential: string;
  dimensions: number | null;
  /** "space" once saved here; "env" while inheriting the instance defaults. */
  source: string;
}

/** Live check of the configured embedder. A failure is data, not an exception. */
export interface EmbeddingsHealth extends EmbeddingsConfig {
  ok: boolean;
  error: string | null;
  /** True when a cloud API key resolved. The key itself is never returned. */
  credentialConfigured: boolean;
}

export interface ReindexResult {
  /** Empty for a space-wide run. */
  attributiveLabel: string;
  /** Number of vectorized SCHEMAs covered by a space-wide run. */
  labels: number | null;
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  capped: boolean;
  aborted: boolean;
}

function mapEmbeddingProvider(value: unknown): EmbeddingProvider {
  return value === "gemini" ? "gemini" : "ollama";
}

function mapEmbeddingsConfig(data: Record<string, unknown>): EmbeddingsConfig {
  const dimensions = Number(data.dimensions);
  return {
    enabled: Boolean(data.enabled),
    provider: mapEmbeddingProvider(data.provider),
    ollamaUrl: String(data.ollama_url || ""),
    baseUrl: String(data.base_url || ""),
    embedModel: String(data.embed_model || data.model || ""),
    credential: String(data.credential || ""),
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : null,
    source: String(data.source || "")
  };
}

export async function fetchEmbeddingsConfig(spaceId: string): Promise<EmbeddingsConfig> {
  const data = await getJson<Record<string, unknown>>(
    `/api/spaces/${encodeURIComponent(spaceId)}/embeddings/config`,
    "Failed to load embedding settings",
    { cache: "no-store" }
  );
  return mapEmbeddingsConfig(data);
}

export async function saveEmbeddingsConfig(
  spaceId: string,
  values: {
    enabled: boolean;
    provider?: EmbeddingProvider;
    ollamaUrl?: string;
    baseUrl?: string;
    embedModel?: string;
    credential?: string;
  }
): Promise<EmbeddingsConfig> {
  const body: Record<string, unknown> = { enabled: values.enabled };
  if (values.provider !== undefined) body.provider = values.provider;
  if (values.ollamaUrl !== undefined) body.ollama_url = values.ollamaUrl;
  if (values.baseUrl !== undefined) body.base_url = values.baseUrl;
  if (values.embedModel !== undefined) body.embed_model = values.embedModel;
  if (values.credential !== undefined) body.credential = values.credential;
  const data = await postJson<Record<string, unknown>>(
    `/api/spaces/${encodeURIComponent(spaceId)}/embeddings/config`,
    body,
    "Failed to save embedding settings"
  );
  return mapEmbeddingsConfig(data);
}

export async function fetchEmbeddingsHealth(spaceId: string): Promise<EmbeddingsHealth> {
  const data = await getJson<Record<string, unknown>>(
    `/api/spaces/${encodeURIComponent(spaceId)}/embeddings/health`,
    "Failed to reach the embedding service",
    { cache: "no-store" }
  );
  return {
    ...mapEmbeddingsConfig(data),
    ok: Boolean(data.ok),
    error: data.error ? String(data.error) : null,
    credentialConfigured: Boolean(data.credential_configured)
  };
}

/** Reindex one type, or every vectorized SCHEMA in the space when the label is omitted. */
export async function reindexEmbeddings(
  spaceId: string,
  attributiveLabel?: string,
  kind: "node" | "relationship" = "node"
): Promise<ReindexResult> {
  const body: Record<string, unknown> = attributiveLabel
    ? { attributive_label: attributiveLabel, kind }
    : {};
  const data = await postJson<Record<string, unknown>>(
    `/api/spaces/${encodeURIComponent(spaceId)}/embeddings/reindex`,
    body,
    "Failed to reindex embeddings"
  );
  const labels = Number(data.labels);
  return {
    attributiveLabel: String(data.attributive_label || attributiveLabel || ""),
    labels: Number.isFinite(labels) ? labels : null,
    scanned: Number(data.scanned || 0),
    embedded: Number(data.embedded || 0),
    skipped: Number(data.skipped || 0),
    failed: Number(data.failed || 0),
    capped: Boolean(data.capped),
    aborted: Boolean(data.aborted)
  };
}

/** What the operator picked to export; the backend resolves the dependency closure. */
export interface TemplateSelection {
  /** Sequence query ids (their steps + nested queries are pulled in automatically). */
  sequences: string[];
  /** Standalone operation query ids. */
  operations: string[];
  /** SCHEMA attributive_labels to include. */
  schemas: string[];
  /** Subset of `schemas` whose INSTANCE nodes/rows should be included too. */
  instances: string[];
  /** Event ids (their referenced sequences are added to the closure). */
  events: string[];
}

/** Resolved counts returned with a template so the UI can show what will be exported. */
export interface TemplateSummary {
  schemas: number;
  steps: number;
  instances: number;
  relationships: number;
  queries: number;
  operations: number;
  sequences: number;
  regex: number;
  events: number;
  resources: number;
  credential_slots: number;
}

/** A portable space template document (opaque to the UI; round-tripped to the API). */
export type TemplateDocument = Record<string, unknown> & {
  template_id?: string;
  summary?: TemplateSummary;
};

/** A name collision the operator must resolve before importing a template. */
export interface TemplateConflict {
  id: string;
  kind: "graph_label" | "regex" | "sequence_name";
  scope: string;
  original_name: string;
  suggested_name: string;
}

/** A credential slot the operator must populate after import (value never travels). */
export interface TemplateCredentialNeeded {
  name: string;
  description: string;
  configured: boolean;
}

export interface TemplatePreview {
  template_id: string;
  space_id: string;
  conflicts: TemplateConflict[];
  credentials_needed: TemplateCredentialNeeded[];
}

/** A user-resolved rename sent back with the apply request. */
export interface TemplateRemap {
  kind: TemplateConflict["kind"];
  original_name: string;
  new_name: string;
}

export interface TemplateImportResult {
  template_id: string;
  status: "complete" | "applying" | "failed" | "pending" | "validated";
  applied: number;
  total: number;
  resumed?: boolean;
}

/** A SCHEMA node label available to include in a template export selection. */
export interface TemplateSchemaOption {
  id: string;
  attributive_label: string;
}

/** List a space's SCHEMA node labels (for the template export selection list). */
export async function fetchTemplateSchemas(
  spaceId: string
): Promise<TemplateSchemaOption[]> {
  const data = await getJson<{ nodes?: TemplateSchemaOption[] }>(
    `/api/graph/nodes-by-label?space_id=${encodeURIComponent(spaceId)}&node_label=SCHEMA`,
    "Failed to load schemas",
    { cache: "no-store" }
  );
  const seen = new Set<string>();
  const out: TemplateSchemaOption[] = [];
  for (const node of data.nodes || []) {
    const label = (node.attributive_label || "").trim();
    if (label && !seen.has(label)) {
      seen.add(label);
      out.push({ id: node.id, attributive_label: label });
    }
  }
  return out;
}

export async function exportTemplate(
  spaceId: string,
  selection: TemplateSelection
): Promise<TemplateDocument> {
  return postJson<TemplateDocument>(
    `/api/spaces/${encodeURIComponent(spaceId)}/templates/export`,
    { selection },
    "Failed to export template"
  );
}

export async function previewTemplateImport(
  spaceId: string,
  template: TemplateDocument
): Promise<TemplatePreview> {
  const data = await postJson<TemplatePreview>(
    `/api/spaces/${encodeURIComponent(spaceId)}/templates/import/preview`,
    { template },
    "Failed to preview template"
  );
  return {
    template_id: data.template_id,
    space_id: data.space_id,
    conflicts: data.conflicts || [],
    credentials_needed: data.credentials_needed || []
  };
}

export async function applyTemplateImport(
  spaceId: string,
  template: TemplateDocument,
  remaps: TemplateRemap[]
): Promise<TemplateImportResult> {
  return postJson<TemplateImportResult>(
    `/api/spaces/${encodeURIComponent(spaceId)}/templates/import/apply`,
    { template, remaps },
    "Failed to import template"
  );
}

/** Hand-rolled (not `getJson`): a 404 means "no import row" and returns null. */
export async function getTemplateImportStatus(
  spaceId: string,
  templateId: string
): Promise<TemplateImportResult | null> {
  const response = await fetch(
    `/api/spaces/${encodeURIComponent(spaceId)}/templates/import/${encodeURIComponent(templateId)}`,
    { cache: "no-store" }
  );
  if (response.status === 404) return null;
  const data = (await response.json().catch(() => ({}))) as TemplateImportResult & {
    error?: string;
  };
  if (!response.ok) throw new Error(data.error || "Failed to load import status");
  return data;
}

export class ChatRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function mapThreadSummary(row: Record<string, unknown>): ChatThreadSummary {
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    turn_status: row.turn_status === "running" ? "running" : "idle",
    updated_at: String(row.updated_at || "")
  };
}

function mapMessage(row: Record<string, unknown>): ChatThread["messages"][number] {
  const batch = row.batch;
  return {
    id: String(row.id || ""),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content || ""),
    tool_calls: Array.isArray(row.tool_calls) ? row.tool_calls : [],
    batch: batch && typeof batch === "object" ? (batch as ChatThread["messages"][number]["batch"]) : null
  };
}

function mapStackItem(row: Record<string, unknown>): ChatStackItem {
  return {
    id: String(row.id || ""),
    kind: row.kind as ChatStackItem["kind"],
    title: String(row.title || ""),
    payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {},
    position: Number(row.position || 0)
  };
}

export async function fetchChatThreads(spaceId: string): Promise<ChatThreadSummary[]> {
  const data = await getJson<{ threads?: Array<Record<string, unknown>> }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads`,
    "Failed to load chats"
  );
  return (data.threads || []).map(mapThreadSummary);
}

export async function fetchChatThread(spaceId: string, threadId: string): Promise<ChatThread> {
  const data = await getJson<Record<string, unknown>>(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}`,
    "Failed to load chat"
  );
  const summary = mapThreadSummary(data);
  return {
    ...summary,
    active_stack_item_id: (data.active_stack_item_id as string | null) ?? null,
    messages: Array.isArray(data.messages) ? data.messages.map((row) => mapMessage(row as Record<string, unknown>)) : [],
    stack: Array.isArray(data.stack) ? data.stack.map((row) => mapStackItem(row as Record<string, unknown>)) : []
  };
}

export async function setActiveChatStackItem(
  spaceId: string,
  threadId: string,
  stackItemId: string | null
): Promise<void> {
  await postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}/active`,
    { stack_item_id: stackItemId },
    "Failed to save the open canvas tab"
  );
}

export async function addChatStackItem(
  spaceId: string,
  threadId: string,
  item: { kind: ChatStackItem["kind"]; title: string; payload: Record<string, unknown> }
): Promise<ChatStackItem> {
  const data = await postJson<{ item: Record<string, unknown> }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}/stack`,
    item,
    "Failed to update the canvas"
  );
  return mapStackItem(data.item);
}

export async function updateChatStackItem(
  spaceId: string,
  threadId: string,
  itemId: string,
  payload: Record<string, unknown>
): Promise<ChatStackItem> {
  const data = await postJson<{ item: Record<string, unknown> }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}/stack/${encodeURIComponent(itemId)}`,
    { payload },
    "Failed to update the canvas"
  );
  return mapStackItem(data.item);
}

export async function acceptChatBatch(spaceId: string, threadId: string): Promise<ChatBatchResult> {
  return postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}/batch/accept`,
    {},
    "Failed to apply the change"
  );
}

export async function rejectChatBatch(spaceId: string, threadId: string): Promise<void> {
  await postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat/threads/${encodeURIComponent(threadId)}/batch/reject`,
    {},
    "Failed to reject the change"
  );
}

export async function fetchChatModel(spaceId: string): Promise<ChatModelSettings> {
  return getJson(`/api/spaces/${encodeURIComponent(spaceId)}/chat-model`, "Failed to load chat model");
}

export async function saveChatModel(
  spaceId: string,
  settings: Partial<ChatModelSettings> & { api_key?: string }
): Promise<ChatModelSettings> {
  return postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/chat-model`,
    settings,
    "Failed to save chat model"
  );
}

/** Stream one agent turn. Throws ChatRequestError before any tokens when the server refuses. */
export async function streamChatTurn(
  spaceId: string,
  body: { threadId: string | null; content: string },
  onEvent: (event: ChatStreamEvent) => void
): Promise<void> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/chat/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: body.threadId, content: body.content })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ChatRequestError(data.error || "Chat request failed", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Chat stream was empty");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(6).trim();
      try {
        const data = JSON.parse(dataLine.slice(5).trim()) as ChatStreamEvent["data"];
        onEvent({ event, data } as ChatStreamEvent);
      } catch {
        // Ignore a truncated frame; the next chunk completes it.
      }
    }
  }
}
