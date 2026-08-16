/** Compose full Cypher, parameters, and SQLite for one query object. */

import { composeInstanceIndexCypher } from "../entity/instance.js";
import { appendCreateReturnStar, joinComposedCypherLines } from "../render/join.js";
import { renderMatchClauses } from "../render/match.js";
import { renderDeleteLine, renderOrderSkipLimit, renderReturnLine } from "../render/return.js";
import { composeReadDefaultNetworkLines, composeReadTraversalLines } from "../render/traversal.js";
import { composeVectorSearchLines } from "../render/vectorSearch.js";
import { renderWhereLine } from "../render/where.js";
import { composeEntitySqlite } from "../sqlite/entity.js";
import type { ComposedQuery, QueryObject } from "../types.js";

function collectParameters(query: QueryObject): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  (query.parameters || []).forEach((p) => {
    if (p && p.name) parameters[p.name] = p.value;
  });
  return parameters;
}

export function composeQuery(query: QueryObject | null | undefined): ComposedQuery {
  if (!query || typeof query !== "object") {
    return { cypher: "", parameters: {}, sqlite: [], operation: "read" };
  }

  const operation = query.operation || "read";
  const allowDuplicates = query.allow_duplicates === true;
  const lines: string[] = [];

  // Update SCHEMA/STEP edits only the per-space entities config (payload) via SQLite;
  // it never runs Cypher. The selected node/relationship's payload is rewritten by
  // composeEntitySqlite (UPDATE … WHERE id = …).
  const primaryLabel = query.match && query.match[0] ? query.match[0].label : undefined;
  if (operation === "update" && (primaryLabel === "STEP" || primaryLabel === "SCHEMA")) {
    return {
      cypher: "",
      sqlite: composeEntitySqlite(query, operation),
      parameters: collectParameters(query),
      operation
    };
  }

  // Vector search replaces the whole MATCH…RETURN shape (engine fills $vector_query).
  // No ORDER BY / LIMIT / RETURN from the query object — k and score order are fixed.
  const vectorLines = composeVectorSearchLines(query);
  if (vectorLines) {
    vectorLines.forEach((line) => lines.push(line));
    return {
      cypher: joinComposedCypherLines(lines, operation),
      sqlite: composeEntitySqlite(query, operation),
      parameters: collectParameters(query),
      operation
    };
  }

  // Read STEP/SCHEMA single-node traversal, and the unconstrained-node network
  // default, both replace the whole MATCH…RETURN shape.
  const replacementLines = composeReadTraversalLines(query) || composeReadDefaultNetworkLines(query);
  if (replacementLines) {
    replacementLines.forEach((line) => lines.push(line));
    renderOrderSkipLimit(query).forEach((line) => lines.push(line));
    return {
      cypher: joinComposedCypherLines(lines, operation),
      sqlite: composeEntitySqlite(query, operation),
      parameters: collectParameters(query),
      operation
    };
  }

  renderMatchClauses(query.match, operation, allowDuplicates).forEach((line) => lines.push(line));

  if (operation === "create") {
    appendCreateReturnStar(lines);
    composeInstanceIndexCypher(query).forEach((line) => lines.push(line));
  }

  const whereLine = renderWhereLine(query.where, query);
  if (whereLine && operation !== "create") {
    // The global WHERE must bind to the last required MATCH, not to a trailing
    // OPTIONAL MATCH line (where it would only null the optional hop instead of
    // filtering rows, and would collide with the segment's own inline WHERE).
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^MATCH\s/.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, whereLine);
  }

  if (operation === "update") {
    const setExprs = (query.set || [])
      .map((s) => (s && s.expression ? s.expression.trim() : ""))
      .filter(Boolean);
    if (setExprs.length) lines.push(`SET ${setExprs.join(", ")}`);
  }

  if (operation === "delete") {
    const deleteLine = renderDeleteLine(query.delete);
    if (deleteLine) lines.push(deleteLine);
  }

  if (operation !== "create") {
    const returnLine = renderReturnLine(query);
    if (returnLine && operation !== "delete") lines.push(returnLine);
  }

  if (operation === "read") {
    renderOrderSkipLimit(query).forEach((line) => lines.push(line));
  }

  return {
    cypher: joinComposedCypherLines(lines, operation),
    sqlite: composeEntitySqlite(query, operation),
    parameters: collectParameters(query),
    operation,
  };
}
