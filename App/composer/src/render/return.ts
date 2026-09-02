/** RETURN, ORDER BY, SKIP, LIMIT, DELETE, and UNWIND clause rendering. */

import { renderLiteralOrParameter } from "../literals.js";
import type { DeleteClause, QueryObject } from "../types.js";

function hideDuplicatesForQuery(query: QueryObject): boolean {
  return query.hide_duplicates === true || !!(query.return && query.return.distinct);
}

/** A complete UNWIND clause ready to emit, or null when it should be ignored. */
export function completeUnwind(
  query: QueryObject
): { alias: string; expressions: string[] } | null {
  if ((query.operation || "read") !== "read") return null;
  const unwind = query.unwind;
  if (!unwind) return null;
  const alias = String(unwind.alias || "").trim();
  const expressions = (unwind.items || [])
    .map((item) => String(item?.expression || "").trim())
    .filter(Boolean);
  if (!alias || expressions.length < 2) return null;
  return { alias, expressions };
}

export function renderUnwindLine(query: QueryObject): string | null {
  const unwind = completeUnwind(query);
  if (!unwind) return null;
  return `UNWIND [${unwind.expressions.join(", ")}] AS ${unwind.alias}`;
}

function returnProjectsAlias(
  items: { expression?: string; alias?: string }[],
  alias: string
): boolean {
  return items.some((item) => {
    const asName = String(item.alias || "").trim();
    const expr = String(item.expression || "").trim();
    return asName === alias || expr === alias;
  });
}

export function renderReturnLine(query: QueryObject): string | null {
  const items = (query.return && query.return.items) || [];
  const operation = query.operation || "read";
  const unwind = completeUnwind(query);
  let ret = "RETURN";
  if (hideDuplicatesForQuery(query)) ret += " DISTINCT";
  const projections = items
    .map((item) => {
      if (!item || !item.expression) return "";
      const expr = item.expression.trim();
      if (!expr) return "";
      return item.alias ? `${expr} AS ${item.alias}` : expr;
    })
    .filter(Boolean);
  if (!projections.length) {
    if (unwind) return `${ret} ${unwind.alias}`;
    return operation === "read" ? `${ret} *` : null;
  }
  if (unwind && !returnProjectsAlias(items, unwind.alias)) {
    projections.unshift(unwind.alias);
  }
  return `${ret} ${projections.join(", ")}`;
}

export function renderOrderSkipLimit(query: QueryObject): string[] {
  const lines: string[] = [];
  if (query.order_by && query.order_by.length) {
    const sortParts = query.order_by
      .map((o) => {
        if (!o || !o.expression) return "";
        let s = `${o.expression.trim()} ${o.direction || "ASC"}`;
        if (o.null_order) s += ` ${o.null_order}`;
        return s;
      })
      .filter(Boolean);
    if (sortParts.length) lines.push(`ORDER BY ${sortParts.join(", ")}`);
  }
  const skip = renderLiteralOrParameter(query.skip);
  if (skip) lines.push(`SKIP ${skip}`);
  const limit = renderLiteralOrParameter(query.limit);
  if (limit) lines.push(`LIMIT ${limit}`);
  return lines;
}

export function renderDeleteLine(del: DeleteClause | null | undefined): string | null {
  if (!del || !del.targets || !del.targets.length) return null;
  const keyword = del.detach ? "DETACH DELETE" : "DELETE";
  return `${keyword} ${del.targets.join(", ")}`;
}
