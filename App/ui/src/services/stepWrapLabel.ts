import connector from "./connector";
import { nextUniqueAttributiveLabel } from "../state/builder/uniqueAttributiveLabel";

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
