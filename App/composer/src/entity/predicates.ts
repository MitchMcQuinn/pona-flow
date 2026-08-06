/** Entity reference and existing-node predicates. */

import type { NodePattern, RelationshipPattern } from "../types.js";

type EntityLike = NodePattern | RelationshipPattern | null | undefined;

export function isExistingGraphNode(entity: EntityLike): boolean {
  return !!(entity && entity.node_source === "existing");
}

export function isEntityReference(entity: EntityLike): boolean {
  return !!(entity && (entity.alias_mode === "reference" || entity.alias_ref));
}
