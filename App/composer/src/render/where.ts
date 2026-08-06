/** WHERE clause normalization and rendering. */

import { cypherNodePropertyRef } from "../cypher-keys.js";
import { formatLiteral } from "../literals.js";
import { hopSplit, lastNodeVariable, renderPath } from "./path.js";
import type { GraphNodeLabel, PathElement, QueryObject, WhereGroup, WhereItem } from "../types.js";

/** Matches a value that is exactly a parameter reference, e.g. "$personName". */
const PARAM_REF_EXACT_RE = /^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeWhere(where: WhereGroup | Array<{ expression?: string }> | null | undefined): WhereGroup | null {
  if (!where) return null;
  if (Array.isArray(where)) {
    const items = where
      .map((w) => (w && w.expression ? { expression: String(w.expression).trim() } : null))
      .filter((w): w is { expression: string } => !!(w && w.expression));
    return items.length ? { operator: "AND", items: items as WhereItem[] } : null;
  }
  if (where.operator && Array.isArray(where.items)) {
    return where;
  }
  return null;
}

function isWhereFilterItem(item: WhereItem | null | undefined): boolean {
  return !!(item && (item as { property_key?: string }).property_key != null && (item as { operator?: string }).operator);
}

function parseWhereFilterValue(raw: unknown): unknown {
  const t = String(raw ?? "").trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

function renderWhereFilterItem(
  filter: { property_key?: string; operator?: string; value?: unknown },
  variable: string
): string {
  if (!filter || !filter.property_key || !variable) return "";
  const lhs = cypherNodePropertyRef(variable, filter.property_key);
  const op = filter.operator || "=";
  if (op === "IS NULL" || op === "IS NOT NULL") {
    return `${lhs} ${op}`;
  }
  const raw = filter.value;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "";
  const rawStr = String(raw).trim();
  // A parameter reference must bind via Neo4j ($name), not be quoted as a literal.
  if (PARAM_REF_EXACT_RE.test(rawStr)) {
    return `${lhs} ${op} ${rawStr}`;
  }
  return `${lhs} ${op} ${formatLiteral(parseWhereFilterValue(raw))}`;
}

export function renderWhereGroup(group: WhereGroup | null | undefined, variable: string): string {
  if (!group || !group.items || !group.items.length) return "";
  const joiner = group.operator === "OR" ? " OR " : " AND ";
  const parts = group.items
    .map((item) => {
      if (!item) return "";
      if (isWhereFilterItem(item)) {
        return variable ? renderWhereFilterItem(item as { property_key: string; operator?: string; value?: unknown }, variable) : "";
      }
      if ((item as { expression?: string }).expression) {
        const expr = String((item as { expression: string }).expression).trim();
        return expr || "";
      }
      if ((item as WhereGroup).operator && (item as WhereGroup).items) {
        const nested = renderWhereGroup(item as WhereGroup, variable);
        return nested ? `(${nested})` : "";
      }
      return "";
    })
    .filter(Boolean);
  return parts.join(joiner);
}

/** Parenthesized WHERE body for one path element, or "" (references contribute nothing). */
export function pathElementWhereBody(step: PathElement): string {
  let entity: { where?: WhereGroup } | null = null;
  let variable = "";
  if (step.kind === "node" && step.node) {
    entity = step.node;
    variable = (step.node.variable || "").trim();
    if (step.node.alias_mode === "reference") return "";
  } else if (step.kind === "relationship" && step.relationship) {
    entity = step.relationship;
    variable = (step.relationship.variable || "").trim();
    if (step.relationship.alias_mode === "reference") return "";
  }
  if (!entity || !variable || !entity.where) return "";
  const body = renderWhereGroup(entity.where, variable);
  return body ? `(${body})` : "";
}

/**
 * NOT EXISTS anti-join body for a path with an absent hop, or "" when the path
 * has none. The negated tail (the absent relationship and everything after it)
 * renders inside the subquery, anchored on the preceding node's bare variable;
 * filters on tail entities move inside the subquery's own WHERE.
 */
export function pathAbsentWhereBody(
  path: PathElement[],
  clauseLabel: GraphNodeLabel | string,
  operation: string
): string {
  const split = hopSplit(path, clauseLabel, operation);
  if (!split || split.mode !== "absent") return "";
  const anchor = lastNodeVariable(path, split.index);
  const tail = renderPath(path.slice(split.index), clauseLabel, operation);
  if (!anchor || !tail) return "";
  const innerBodies = path
    .slice(split.index)
    .map((el) => pathElementWhereBody(el))
    .filter(Boolean);
  const innerWhere = innerBodies.length ? ` WHERE ${innerBodies.join(" AND ")}` : "";
  return `NOT EXISTS { MATCH (${anchor})${tail}${innerWhere} }`;
}

function collectPathWhereBodies(query: QueryObject): string[] {
  const bodies: string[] = [];
  const operation = query.operation || "read";
  (query.match || []).forEach((clause, clauseIndex) => {
    // Clause-level OPTIONAL MATCH clauses (every clause after the first may opt in)
    // carry their filters inline on their own line — the global WHERE renders before
    // them, where their variables are not yet bound.
    if (clauseIndex > 0 && clause.optional === true) return;
    (clause.patterns || []).forEach((pattern) => {
      const path = pattern.path || [];
      // Entities in optional-hop segments carry their filters on their own
      // OPTIONAL MATCH line (see render/match.ts) — a null hop must not fail
      // the global WHERE and drop the anchor's row. Entities in an absent tail
      // carry their filters inside the NOT EXISTS subquery instead.
      const split = hopSplit(path, clause.label || "", operation);
      const splitIndex = split ? split.index : -1;
      path.forEach((step, stepIndex) => {
        if (splitIndex >= 0 && stepIndex >= splitIndex) return;
        const body = pathElementWhereBody(step);
        if (body) bodies.push(body);
      });
      const absentBody = pathAbsentWhereBody(path, clause.label || "", operation);
      if (absentBody) bodies.push(absentBody);
    });
  });
  return bodies;
}

export function renderWhereLine(
  where: WhereGroup | null | undefined,
  query: QueryObject | null | undefined
): string | null {
  const parts: string[] = [];
  const group = normalizeWhere(where);
  if (group) {
    const body = renderWhereGroup(group, "");
    if (body) parts.push(body);
  }
  if (query) {
    collectPathWhereBodies(query).forEach((b) => parts.push(b));
  }
  if (!parts.length) return null;
  return `WHERE ${parts.join(" AND ")}`;
}
