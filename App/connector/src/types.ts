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
    step_type?: "http" | "code";
    endpoint?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
    /** Code-execution STEP: backing catalog resources row (code fetched separately). */
    resource_id?: string;
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
}

export interface SchemaOutgoingEdge {
  rel_id: string;
  rel_attributive_label: string;
  target_id: string;
  target_attributive_label: string;
  rel_schemata: SchemaPropertyConstraint[];
  target_schemata: SchemaPropertyConstraint[];
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
