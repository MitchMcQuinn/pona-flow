/** INSTANCE payload and index Cypher generation. */

import { cypherNodePropertyRef } from "../cypher-keys.js";
import { sanitizeIndexToken } from "./labels.js";
import type { QueryObject } from "../types.js";
import type { NodePattern, RelationshipPattern } from "../types.js";

type EntityLike = NodePattern | RelationshipPattern;

export function instancePropertiesObject(nodeOrRel: EntityLike | null | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  ((nodeOrRel && nodeOrRel.properties) || []).forEach((p) => {
    if (!p || !p.key) return;
    const key = String(p.key);
    if (key === "id" || key === "attributive_label") return;
    if (p.parameter) return;
    if (p.value !== undefined) props[key] = p.value;
  });
  return props;
}

export function instancePayloadFromEntity(entity: EntityLike | null | undefined): string {
  return JSON.stringify({ properties: instancePropertiesObject(entity) });
}

export function composeInstanceIndexCypher(query: QueryObject): string[] {
  const statements: string[] = [];
  const seen = new Set<string>();
  (query.match || []).forEach((clause) => {
    if ((clause.label || "") !== "INSTANCE") return;
    (clause.patterns || []).forEach((pattern) => {
      (pattern.path || []).forEach((step) => {
        const entity =
          step.kind === "node"
            ? step.node
            : step.kind === "relationship"
              ? step.relationship
              : null;
        if (!entity || entity.alias_mode === "reference") return;
        const al = sanitizeIndexToken(entity.attributive_label || "instance");
        (entity.properties || []).forEach((p) => {
          if (!p || !p.key || !p.schematic_properties || !p.schematic_properties.is_indexed) {
            return;
          }
          const key = String(p.key);
          const indexName = `instance_${al}_${sanitizeIndexToken(key)}`.slice(0, 60);
          if (seen.has(indexName)) return;
          seen.add(indexName);
          statements.push(
            `CREATE INDEX ${indexName} IF NOT EXISTS FOR (n:INSTANCE) ON (${cypherNodePropertyRef("n", key)})`
          );
        });
      });
    });
  });
  return statements;
}
