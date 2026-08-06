/** Entity label resolution for SQLite common_label column. */

import type { GraphNodeLabel, NodePattern, RelationshipPattern } from "../types.js";

type EntityLike = NodePattern | RelationshipPattern | null | undefined;

export function commonLabelForEntity(entity: EntityLike, nodeLabel: GraphNodeLabel | string): string {
  const kind = String(nodeLabel || "").trim();
  if (kind === "STEP" || kind === "SCHEMA") {
    return entity && entity.attributive_label ? String(entity.attributive_label).trim() : "";
  }
  if (kind === "INSTANCE") {
    const props = (entity && entity.properties) || [];
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      if (!p || !p.key) continue;
      const sp = p.schematic_properties;
      if (sp && sp.is_label) {
        if (p.value !== undefined && p.value !== null) {
          return String(p.value).trim();
        }
        return "";
      }
    }
    return entity && entity.attributive_label ? String(entity.attributive_label).trim() : "";
  }
  return "";
}

export function sanitizeIndexToken(value: unknown): string {
  return String(value || "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
