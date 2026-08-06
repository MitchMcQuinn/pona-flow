// Orchestrates an add/delete-only SCHEMA update from the builder: extract the edited schemata,
// preview which sequences the change would break (their INSTANCE step would no longer match the
// new pattern) plus how many live instances would fall out of sync, so the user can confirm, then
// apply the structured (lock-enforcing) update on the server. Applying suspends every affected
// sequence until its INSTANCE step is re-saved, auto-removes deleted properties from existing
// instances, and stamps is_current=false on instances missing a newly-added required property
// (see Engine/server/schema_suspension.py and Engine/server/schema_currency.py).
import connector from "./connector";
import type {
  AffectedSequence,
  SchemaPropertyConstraint,
  SuspensionChange,
} from "./connector";
import { effectiveSchemaSchemataPayload } from "../state/builder/schemaRules";
import type {
  BuilderState,
  NodePattern,
  PropertyBinding,
  QueryObject,
  RelationshipPattern
} from "../state/builder/types";

/** The element (node or relationship) whose SCHEMA config is being edited in an update query. */
type SchemaUpdateSubject = NodePattern | RelationshipPattern;

/**
 * The SCHEMA element being edited in an update query. A relationship-SCHEMA update edits the
 * POINTS_TO relationship element (its properties + rel id), while the path's endpoint nodes are
 * loaded only as locked context — so a relationship subject (one with an attributive_label) takes
 * precedence over the endpoint nodes. A node-SCHEMA update has a node-only path.
 */
function findUpdateSchemaSubject(query: QueryObject): SchemaUpdateSubject | null {
  let firstNode: SchemaUpdateSubject | null = null;
  for (const clause of query.match || []) {
    if (clause.label !== "SCHEMA") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        if (el.kind === "relationship") {
          if ((el.relationship.attributive_label ?? "").trim()) return el.relationship;
        } else if (el.kind === "node" && !firstNode) {
          firstNode = el.node;
        }
      }
    }
  }
  return firstNode;
}

/** Editor property bindings -> effective key-based constraints (incl. the implicit UID key). */
function constraintsFromBindings(props: PropertyBinding[]): SchemaPropertyConstraint[] {
  return effectiveSchemaSchemataPayload(props).map(({ property_schema: ps }) => {
    const constraint: SchemaPropertyConstraint = {
      key: ps.name,
      value_type: ps.value_type,
      is_required: ps.is_required,
      is_key: ps.is_key,
      is_label: ps.is_label,
      is_indexed: ps.is_indexed
    };
    if (ps.format) constraint.format = ps.format;
    if (ps.options) constraint.options = ps.options;
    if (typeof ps.min_choices === "number") constraint.min_choices = ps.min_choices;
    if (typeof ps.max_choices === "number") constraint.max_choices = ps.max_choices;
    if (ps.default_value !== undefined) constraint.default_value = ps.default_value;
    return constraint;
  });
}

/** The pieces of a SCHEMA update extracted from the builder state. */
export interface SchemaUpdateInput {
  spaceId: string;
  schemaId: string;
  attributiveLabel: string;
  schemata: SchemaPropertyConstraint[];
}

/** Pull the edited SCHEMA node + its constraints out of the current builder query. */
export function extractSchemaUpdateInput(state: BuilderState): SchemaUpdateInput {
  const spaceId = state.spaceId;
  if (!spaceId) throw new Error("Select a space before updating a schema.");
  const subject = findUpdateSchemaSubject(state.query);
  if (!subject) throw new Error("No SCHEMA selected to update.");
  const schemaId = String(subject.id_binding?.value ?? "").trim();
  const attributiveLabel = (subject.attributive_label ?? "").trim();
  if (!schemaId) throw new Error("Select an existing SCHEMA to update.");
  if (!attributiveLabel) throw new Error("The selected SCHEMA is missing an attributive_label.");
  return { spaceId, schemaId, attributiveLabel, schemata: constraintsFromBindings(subject.properties) };
}

export interface SchemaUpdatePreviewOutcome {
  input: SchemaUpdateInput;
  added: string[];
  deleted: string[];
  /** Sequences that would be suspended (an INSTANCE step would no longer match the pattern). */
  affectedSequences: AffectedSequence[];
  /** Standalone INSTANCE operations (not used by any sequence) that would be suspended. */
  affectedOperations: AffectedSequence[];
  /** Live INSTANCE nodes/relationships that would be marked out of sync by this change. */
  outOfSyncInstanceCount: number;
}

/** Total rows (sequences + standalone operations) a preview would suspend. */
export function affectedCount(preview: SchemaUpdatePreviewOutcome): number {
  return preview.affectedSequences.length + preview.affectedOperations.length;
}

/** Whether a preview has any impact worth confirming (suspensions or out-of-sync instances). */
export function hasSchemaUpdateImpact(preview: SchemaUpdatePreviewOutcome): boolean {
  return affectedCount(preview) > 0 || preview.outOfSyncInstanceCount > 0;
}

/**
 * Dry-run the update: validate the diff and report the sequences + standalone operations it
 * would suspend. Mutates nothing — the caller shows a confirmation modal when anything is
 * affected and only then calls {@link applySchemaUpdate}.
 */
export async function previewSchemaUpdate(
  state: BuilderState
): Promise<SchemaUpdatePreviewOutcome> {
  const input = extractSchemaUpdateInput(state);
  const preview = await connector.previewSchemaUpdate(input);
  return {
    input,
    added: preview.added || [],
    deleted: preview.deleted || [],
    affectedSequences: preview.affected_sequences || [],
    affectedOperations: preview.affected_operations || [],
    outOfSyncInstanceCount: preview.out_of_sync_instance_count || 0
  };
}

export interface SchemaUpdateOutcome {
  attributiveLabel: string;
  added: string[];
  deleted: string[];
  /** Sequences suspended/released by this update. */
  suspension: SuspensionChange;
  /** Live INSTANCE reconciliation: deleted properties auto-removed, instances marked out of sync. */
  instances: { deletedFrom: number; marked: number };
}

/**
 * Persist the validated SCHEMA update. The server applies the add/delete-only change and
 * suspends every sequence whose INSTANCE step no longer matches the new pattern. Pass the
 * ``input`` from {@link previewSchemaUpdate} (or extract it fresh) so the applied diff matches
 * what the user confirmed.
 */
export async function applySchemaUpdate(
  stateOrInput: BuilderState | SchemaUpdateInput
): Promise<SchemaUpdateOutcome> {
  const input =
    "schemata" in stateOrInput && "schemaId" in stateOrInput
      ? (stateOrInput as SchemaUpdateInput)
      : extractSchemaUpdateInput(stateOrInput as BuilderState);

  const result = await connector.updateSchemaDefinition(input);

  return {
    attributiveLabel: input.attributiveLabel,
    added: (result.added || []).map((a) => a.key),
    deleted: result.deleted || [],
    suspension: result.suspension ?? { suspended: [], unsuspended: [] },
    instances: {
      deletedFrom: result.instances?.deleted_from ?? 0,
      marked: result.instances?.marked ?? 0
    }
  };
}
