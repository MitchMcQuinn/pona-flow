/** RETURN, ORDER BY, SKIP, LIMIT, and DELETE clause rendering. */

import { renderLiteralOrParameter } from "../literals.js";
import type { DeleteClause, QueryObject } from "../types.js";

function hideDuplicatesForQuery(query: QueryObject): boolean {
  return query.hide_duplicates === true || !!(query.return && query.return.distinct);
}

export function renderReturnLine(query: QueryObject): string | null {
  const items = (query.return && query.return.items) || [];
  const operation = query.operation || "read";
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
    return operation === "read" ? `${ret} *` : null;
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
