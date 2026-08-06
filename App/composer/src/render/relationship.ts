/** Cypher relationship segment rendering. */

import { GRAPH_PAYLOAD_LABELS } from "../constants.js";
import { renderPropertyMap } from "../cypher-keys.js";
import { relationshipPropertiesForCypher } from "../entity/properties.js";
import { isEntityReference } from "../entity/predicates.js";
import type { GraphNodeLabel, RelationshipPattern } from "../types.js";

interface RenderRelOpts {
  variable?: string;
  clauseLabel?: GraphNodeLabel | string;
  operation?: string;
}

export function relationshipDirection(rel: RelationshipPattern | null | undefined): "incoming" | "outgoing" {
  return rel && rel.direction === "incoming" ? "incoming" : "outgoing";
}

export function renderRelationship(rel: RelationshipPattern | null | undefined, opts: RenderRelOpts = {}): string {
  if (!rel) return "-[]->";
  const options = opts || {};
  const relVar = rel.variable || options.variable;
  if (!relVar) return "-[]->";
  if (isEntityReference(rel)) {
    const direction = relationshipDirection(rel);
    if (direction === "incoming") return `<-[${relVar}]-`;
    return `-[${relVar}]->`;
  }
  const relType = rel.type || "POINTS_TO";
  const propOpts = {
    clauseLabel: options.clauseLabel,
    operation: options.operation,
    graphOnly:
      options.operation === "create" &&
      !!options.clauseLabel &&
      GRAPH_PAYLOAD_LABELS.includes(options.clauseLabel as (typeof GRAPH_PAYLOAD_LABELS)[number]),
  };
  let mid = "[";
  mid += relVar;
  if (relType) {
    mid += ":";
    mid += relType;
  }
  // Cypher grammar: the variable-length range must precede the property map
  // ([r:TYPE*0..5 { key: value }]), never follow it.
  if (rel.length && (rel.length.min !== undefined || rel.length.max !== undefined)) {
    const min = rel.length.min !== undefined && rel.length.min !== "" ? rel.length.min : 1;
    const max = rel.length.max;
    if (max !== undefined && max !== null && max !== "") {
      mid += `*${min}..${max}`;
    } else {
      mid += `*${min}..`;
    }
  }
  mid += renderPropertyMap(relationshipPropertiesForCypher(rel, propOpts));
  mid += "]";

  const direction = relationshipDirection(rel);
  if (direction === "incoming") return `<-${mid}-`;
  return `-${mid}->`;
}
