/** Cypher node pattern rendering. */

import { GRAPH_PAYLOAD_LABELS } from "../constants.js";
import { renderPropertyMap } from "../cypher-keys.js";
import { nodePropertiesForCypher } from "../entity/properties.js";
import { isEntityReference, isExistingGraphNode } from "../entity/predicates.js";
import { exactParameterName, formatLiteral } from "../literals.js";
import type { GraphNodeLabel, NodePattern } from "../types.js";

interface RenderNodeOpts {
  variable?: string;
  label?: string;
  clauseLabel?: GraphNodeLabel | string;
  operation?: string;
}

export function renderMatchExistingNode(
  node: NodePattern,
  clauseLabel: GraphNodeLabel | string
): string {
  const variable = node.variable;
  if (!variable) return "";
  const label =
    clauseLabel ||
    (node.labels && node.labels.length ? node.labels.filter(Boolean)[0] : "");
  let s = `MATCH (${variable}`;
  if (label) s += `:${label}`;
  // Existing graph nodes are keyed by id; attributive_label may differ after UI normalization.
  if (isExistingGraphNode(node)) {
    const id = node.id_binding?.value;
    if (!id) return "";
    // An exact "$name" id is a run-time parameter (target supplied when the
    // sequence runs): emit a bind parameter instead of a quoted literal.
    const paramName = exactParameterName(id);
    s += paramName ? ` { id: $${paramName} }` : ` { id: ${formatLiteral(String(id))} }`;
  } else {
    const propOpts = {
      clauseLabel,
      operation: "create",
      graphOnly: true,
      entityKind: "node" as const,
    };
    s += renderPropertyMap(nodePropertiesForCypher(node, propOpts));
  }
  s += ")";
  return s;
}

export function renderNode(node: NodePattern | null | undefined, opts: RenderNodeOpts = {}): string {
  if (!node) return "()";
  const options = opts || {};
  const variable = options.variable || node.variable;
  if (isEntityReference(node)) {
    return variable ? `(${variable})` : "()";
  }
  if (options.operation === "create" && isExistingGraphNode(node)) {
    return variable ? `(${variable})` : "()";
  }
  const label =
    options.label ||
    (node.labels && node.labels.length ? node.labels.filter(Boolean)[0] : "");
  const propOpts = {
    clauseLabel: options.clauseLabel,
    operation: options.operation,
    graphOnly:
      options.operation === "create" &&
      !!options.clauseLabel &&
      GRAPH_PAYLOAD_LABELS.includes(options.clauseLabel as (typeof GRAPH_PAYLOAD_LABELS)[number]),
  };
  let s = "(";
  if (options.variable) s += options.variable;
  if (label) s += `:${label}`;
  s += renderPropertyMap(nodePropertiesForCypher(node, propOpts));
  s += ")";
  return s;
}
