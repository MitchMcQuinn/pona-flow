/** Read STEP/SCHEMA single-node traversal rendering (downstream / network). */

import { escapeCypherString } from "../literals.js";
import type { NodePattern, QueryObject } from "../types.js";

const ATTRIBUTIVE_LABEL_PARAM_RE = /^\$(?![0-9])([A-Za-z_][A-Za-z0-9_]*)$/;

interface SingleMatchNode {
  node: NodePattern;
  label: string;
}

/** The lone match node when the whole query has exactly one node, else null. */
function findSingleMatchNode(query: QueryObject): SingleMatchNode | null {
  let found: SingleMatchNode | null = null;
  let count = 0;
  for (const clause of query.match || []) {
    for (const pattern of clause.patterns || []) {
      for (const element of pattern.path || []) {
        if (element.kind === "node") {
          count += 1;
          if (count > 1) return null;
          const label =
            (element.node.labels && element.node.labels.filter(Boolean)[0]) ||
            clause.label ||
            "";
          found = { node: element.node, label };
        }
      }
    }
  }
  return count === 1 ? found : null;
}

/** A node carrying no match constraint (no attributive_label, id, or properties). */
function nodeIsUnconstrained(node: NodePattern): boolean {
  if (String(node.attributive_label || "").trim()) return false;
  const idValue = node.id_binding?.value;
  if (idValue !== undefined && idValue !== null && idValue !== "") return false;
  const hasProperty = (node.properties || []).some(
    (p) =>
      p &&
      p.key &&
      (Boolean(p.parameter) || (p.value !== undefined && p.value !== null && p.value !== ""))
  );
  return !hasProperty;
}

function clauseHasWhere(query: QueryObject): boolean {
  return Boolean(query.where && Array.isArray(query.where.items) && query.where.items.length);
}

function hasReturnProjections(query: QueryObject): boolean {
  return Boolean(
    query.return && Array.isArray(query.return.items) && query.return.items.length
  );
}

function attributiveLabelPropertyMap(attributiveLabel: string): string {
  const al = attributiveLabel.trim();
  if (!al) return "";
  const paramMatch = ATTRIBUTIVE_LABEL_PARAM_RE.exec(al);
  const rhs = paramMatch ? `$${paramMatch[1]}` : escapeCypherString(al);
  return ` { attributive_label: ${rhs} }`;
}

/**
 * Cypher lines for a STEP/SCHEMA single-node traversal read, or null when the
 * query is not an applicable traversal (wrong operation, label, node count, or
 * no traversal mode selected).
 */
export function composeReadTraversalLines(query: QueryObject): string[] | null {
  if ((query.operation || "read") !== "read") return null;
  const mode = query.read_traversal;
  if (mode !== "downstream" && mode !== "network") return null;

  const single = findSingleMatchNode(query);
  if (!single) return null;
  if (single.label !== "STEP" && single.label !== "SCHEMA") return null;

  const attributiveLabel = String(single.node.attributive_label || "").trim();
  const start = `(:${single.label}${attributiveLabelPropertyMap(attributiveLabel)})`;
  const relationship = mode === "downstream" ? "-[*]->" : "-[*]-";
  const endVariable = mode === "downstream" ? "downstream" : "connected";

  return [`MATCH path = ${start}${relationship}(${endVariable})`, "RETURN path"];
}

/**
 * Default read for an unconstrained single node (no attributive_label/properties,
 * no traversal mode, no WHERE/projections): match the node's full network as
 * `MATCH (n:LABEL)-[r*]-(n) RETURN *`, or null when not applicable.
 */
export function composeReadDefaultNetworkLines(query: QueryObject): string[] | null {
  if ((query.operation || "read") !== "read") return null;
  if (query.read_traversal === "downstream" || query.read_traversal === "network") return null;
  if (clauseHasWhere(query) || hasReturnProjections(query)) return null;

  const single = findSingleMatchNode(query);
  if (!single || !single.label) return null;
  if (!nodeIsUnconstrained(single.node)) return null;

  return [`MATCH (n:${single.label})-[r*]-(n)`, "RETURN *"];
}
