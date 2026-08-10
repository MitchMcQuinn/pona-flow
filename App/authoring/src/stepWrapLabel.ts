import { composer } from "@pona-flow/composer";
import { connector } from "@pona-flow/connector";
import { nextUniqueAttributiveLabel } from "./uniqueAttributiveLabel.js";

/**
 * Resolve the attributive_label for an auto-wrapped STEP node. When the requested
 * name is already used by another STEP in the graph, append a sequential suffix
 * starting at 1 (FOO -> FOO1). The wrapping entity's own label is excluded so
 * re-saves of the same operation keep their current label when still available.
 */
export async function resolveStepWrapAttributiveLabel(
  spaceId: string,
  baseName: string,
  ownEntityId?: string
): Promise<string> {
  const rows = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" });
  const taken = new Set<string>();
  for (const row of rows) {
    const label = (row.attributive_label || "").trim();
    if (!label) continue;
    if (ownEntityId && row.id === ownEntityId) continue;
    taken.add(label);
  }
  return nextUniqueAttributiveLabel(baseName, taken);
}

/**
 * Auto-create a STEP node (entities row + graph node) that wraps a freshly saved
 * operation or sequence so it is immediately selectable from the operations dropdown
 * in the create STEP flow, eliminating the manual "wrap in a STEP node" step. Both
 * writes are idempotent, so re-saving never produces a duplicate wrapping STEP node.
 */
export async function autoWrapInStep(
  spaceId: string,
  wrappedId: string,
  name: string
): Promise<void> {
  let entityId = "";
  if (spaceId) {
    try {
      entityId = (await connector.fetchStepWrapEntityId({ spaceId, operationId: wrappedId })).trim();
    } catch {
      entityId = "";
    }
  }
  if (!entityId) {
    entityId = await connector.generateQueryId();
  }
  const params = { entityId, operationId: wrappedId, name };
  const sqlite = composer.composeStepWrapEntitySql(params) ?? [];
  const cypher = composer.composeStepWrapGraphCypher(params) ?? [];
  if (!sqlite.length && !cypher.length) return;
  // Register the wrapping STEP node's attributive_label in the active space's labels
  // array (catalog spaces.labels), so it surfaces like any manually created STEP node.
  const attributive_labels = name.trim() ? [name.trim()] : [];
  await connector.executeCreatePackage({
    space_id: spaceId,
    node_label: "STEP",
    cypher,
    sqlite,
    cypher_params: {},
    attributive_labels,
    // The wrap MERGEs a fixed entity id, so re-saving legitimately re-claims its own label.
    attributive_label_owner_ids: [entityId]
  });
}

/** Entity id of the STEP node wrapping a saved operation, or "" when it has none yet. */
export async function stepWrapEntityId(spaceId: string, operationId: string): Promise<string> {
  if (!spaceId) return "";
  try {
    return (await connector.fetchStepWrapEntityId({ spaceId, operationId })).trim();
  } catch {
    return "";
  }
}
