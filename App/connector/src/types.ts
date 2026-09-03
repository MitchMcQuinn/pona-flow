/** Shared response types for the dev-server API client. */

export interface SavedQueryRow {
  id: string;
  name: string;
  kind: string;
  operation: string;
  runtime_enabled: number;
  author_selectable: number;
  /** 1 when a SCHEMA change invalidated this query and it cannot run until re-saved. */
  suspended?: number;
  /** True when this sequence's Cypher matches a single STEP (no downstream walk). */
  single_step?: boolean;
  cypher?: string[];
}

/** One catalog query's full package, including the declarative builder snapshot. */
export interface QueryPackageRow {
  id: string;
  name: string;
  cypher: string[];
  sqlite: string[];
  parameters: unknown[];
  /** Declarative builder snapshot ({} when none was captured at save time). */
  builder_config: Record<string, unknown>;
  /** Sequences: loop termination rule ({} for a plain DAG walk). */
  loop_config?: Record<string, unknown>;
  description?: string;
  group_title?: string;
}

export interface GraphNodeRow {
  id: string;
  attributive_label: string;
  display_label?: string;
  // Shape mirrors the composer's SequencialProperties so a fetched node's config can be
  // assigned straight into a builder query without a cast. method/body use the same
  // strict types as the composer (HTTP verb union; object body) rather than string/unknown.
  sequencial_properties?: {
    query_id?: string;
    step_type?: "http" | "code" | "local_llm";
    endpoint?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
    /** Leftover code-execution STEP (archived); payload references a catalog resource id. */
    resource_id?: string;
    /** Local LLM STEP: catalog local_llm_configs row id. */
    local_llm_config_id?: string;
    response_parameters?: Array<{
      property_path: string;
      parameter: string;
      default_value?: string;
    }>;
  };
  /** Custom-endpoint STEP input parameters (from the entities ``parameters`` column). */
  parameters?: Array<Record<string, unknown>>;
}

export interface GraphRelationshipRow {
  id: string;
  attributive_label: string;
  condition?: string;
  condition_type?: string;
  condition_expected?: boolean;
}

export interface StepOutgoingEdge {
  rel_id: string;
  rel_attributive_label: string;
  target_id: string;
  target_attributive_label: string;
  condition?: string;
  condition_type?: string;
  condition_expected?: boolean;
}

export interface SchemaPropertyConstraint {
  key: string;
  value_type: string;
  is_required: boolean;
  is_key: boolean;
  is_label: boolean;
  is_indexed: boolean;
  /** Include this property's value in the record's vector-search embedding text. */
  is_embedded?: boolean;
  format?: string;
  default_value?: string;
  /** radio + checkbox: the choices the end user picks from. */
  options?: string[];
  /** checkbox: minimum number of choices the end user must select. */
  min_choices?: number;
  /** checkbox: maximum number of choices the end user may select. */
  max_choices?: number;
}

export interface SchemaDefinition {
  space_id: string;
  schema_id: string;
  attributive_label: string;
  schemata: SchemaPropertyConstraint[];
  /** SCHEMA-level: this type's INSTANCE records are embedded for vector search. */
  is_vectorized?: boolean;
}

export interface SchemaOutgoingEdge {
  rel_id: string;
  rel_attributive_label: string;
  target_id: string;
  target_attributive_label: string;
  rel_schemata: SchemaPropertyConstraint[];
  target_schemata: SchemaPropertyConstraint[];
  /** The relationship type's own vector-search opt-in. */
  rel_is_vectorized?: boolean;
  /**
   * Edge direction from the queried node's perspective ("outgoing" when omitted).
   * Incoming edges only appear when the fetch opts in via includeIncoming;
   * target_* then names the edge's source node (the node on the other end).
   */
  direction?: "outgoing" | "incoming";
}

/** A sequence affected by a SCHEMA change (its INSTANCE step no longer matches the pattern). */
export interface AffectedSequence {
  id: string;
  name: string;
}

/** Sequences whose suspended flag flipped as a result of a SCHEMA update / operation re-save. */
export interface SuspensionChange {
  suspended: AffectedSequence[];
  unsuspended: AffectedSequence[];
}

/** Result of an add/delete-only SCHEMA update: the applied diff + new effective schemata. */
export interface SchemaUpdateResult {
  space_id: string;
  schema_id: string;
  attributive_label: string;
  /** Newly added properties (key-based constraints). */
  added: SchemaPropertyConstraint[];
  /** Names of deleted properties. */
  deleted: string[];
  /** New effective schemata after the update. */
  schemata: SchemaPropertyConstraint[];
  /** Sequences suspended/released by this update (INSTANCE steps that no longer match). */
  suspension?: SuspensionChange;
  /** Live INSTANCE reconciliation: properties auto-removed, instances marked, and markers cleared. */
  instances?: { deleted_from: number; marked: number; cleared?: number };
}

/** Dry-run for a SCHEMA update: validated diff + the sequences/operations that would suspend. */
export interface SchemaUpdatePreview {
  space_id: string;
  attributive_label: string;
  added: string[];
  deleted: string[];
  affected_sequences: AffectedSequence[];
  /** Standalone INSTANCE operations (not used by any sequence) that would be suspended. */
  affected_operations: AffectedSequence[];
  /** INSTANCE nodes/relationships that would be marked out of sync (missing a new required prop). */
  out_of_sync_instance_count: number;
}

/** A create-INSTANCE operation in the catalog that targets a given SCHEMA. */
export interface SchemaAffectedOperation {
  id: string;
  name: string;
  operation: string;
  runtime_enabled: number;
  group_title?: string | null;
  /** Full declarative builder snapshot used to recompile the operation during reconciliation. */
  builder_config: Record<string, unknown>;
}

export interface ExecuteCreateBody {
  space_id: string;
  /** Primary graph element being created (STEP|SCHEMA|INSTANCE); drives RBAC flow checks. */
  node_label?: string;
  cypher: string[];
  sqlite: string[];
  cypher_params?: Record<string, unknown>;
  attributive_labels?: string[];
  /**
   * Entity ids this package writes. The server treats an attributive_label held only by
   * these as the caller re-saving its own entity rather than colliding with another one.
   */
  attributive_label_owner_ids?: string[];
  queries_catalog?: {
    id: string;
    name: string;
    kind?: string;
    operation?: string;
    runtime_enabled?: boolean;
    author_selectable?: boolean;
    cypher: string[];
    sqlite: string[];
    parameters: unknown[];
  };
}

/** Body for POST /api/execute-query (read / update / delete packages). */
export interface ExecuteQueryBody {
  space_id: string;
  operation: string;
  node_label?: string;
  cypher: string[];
  sqlite: string[];
  cypher_params?: Record<string, unknown>;
  /** Catalog parameter rows (including ``vector_role``) so the engine can embed author-named search text. */
  parameters?: unknown[];
}

export interface CypherStatementResult {
  records?: Array<Record<string, unknown>>;
  graph?: {
    nodes: Array<Record<string, unknown>>;
    relationships: Array<Record<string, unknown>>;
  };
  summary?: Record<string, unknown>;
}

export interface ExecuteQueryResponse {
  result?: {
    operation?: string;
    cypher?: CypherStatementResult[];
    sqlite?: Array<{ rowcount?: number; lastrowid?: number }>;
  };
}

/**
 * Body for POST /api/queries/upsert. `builder_config` is the declarative QueryObject
 * snapshot that lets a saved package be reopened in the visual builder; the composer is
 * forward-only, so omitting it makes the row un-editable.
 */
export interface QueriesUpsertPayload {
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
  description?: string;
  builder_config?: unknown;
  /**
   * Sequences: the termination rule for the one cycle in the STEP graph. Its own column
   * rather than a builder_config field because the executor reads it directly. Omit for
   * a plain DAG walk.
   */
  loop_config?: unknown;
}

export interface DeleteWarning {
  code: string;
  message: string;
}

export interface DeleteSpaceRef {
  id: string;
  name: string;
}

/** Shared shape of the SCHEMA / STEP delete-cascade dry run. */
interface DeletePreviewBase {
  space_id: string;
  attributive_label: string;
  mode: "purge" | "unlink";
  requires_confirmation?: boolean;
  warnings: DeleteWarning[];
}

/** Shared shape of an executed SCHEMA / STEP delete cascade. */
interface DeleteResultBase {
  space_id: string;
  attributive_label: string;
  mode: "purge" | "unlink";
  purged: boolean;
  unlinked_labels: string[];
  warnings: DeleteWarning[];
  entities_deleted?: number;
  catalog?: { queries_deleted: number; state_deleted: number };
  graph?: { nodes_deleted: number };
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

export interface SchemaDeletePreview extends DeletePreviewBase {
  summary: Record<string, number>;
  affected: Record<string, unknown>;
}

export type SchemaDeleteResult = DeleteResultBase;

export interface StepDeletePreview extends DeletePreviewBase {
  summary: Record<string, number>;
  affected: Record<string, unknown>;
}

export type StepDeleteResult = DeleteResultBase;

export interface SpaceConnections {
  space_id: string;
  name?: string;
  endpoint?: string;
}

export interface SpaceRow {
  id: string;
  name: string;
  sort_date?: string;
  sqlite_database_path_key?: string;
}
