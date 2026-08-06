/** MATCH / CREATE / MERGE clause rendering from match clause objects. */

import { collectExistingNodeMatches } from "./existing-nodes.js";
import { hopSplit, lastNodeVariable, renderPath } from "./path.js";
import { pathAbsentWhereBody, pathElementWhereBody } from "./where.js";
import type { MatchClause, PathElement } from "../types.js";

interface OptionalSegment {
  /** Variable of the preceding node, re-bound bare as the segment's start. */
  anchor: string;
  elements: PathElement[];
}

/**
 * Split the optional tail (from the first optional relationship) into per-hop
 * segments, each anchored on the previous segment's tail node. One OPTIONAL MATCH
 * per hop lets each level match independently (an anchor with the first hop but
 * not the second still returns).
 */
function collectOptionalSegments(path: PathElement[], splitIndex: number): OptionalSegment[] {
  const segments: OptionalSegment[] = [];
  let anchor = lastNodeVariable(path, splitIndex);
  let idx = splitIndex;
  while (idx < path.length) {
    const elements: PathElement[] = [path[idx]];
    idx += 1;
    while (idx < path.length) {
      const el = path[idx];
      if (el.kind === "relationship") {
        const prev = path[idx - 1];
        const prevVariable =
          prev.kind === "node" ? ((prev.node && prev.node.variable) || "").trim() : "";
        // A named node before the next hop closes this segment; the hop re-anchors on it.
        if (prevVariable) break;
      }
      elements.push(el);
      idx += 1;
    }
    segments.push({ anchor, elements });
    anchor = lastNodeVariable(path, idx) || anchor;
  }
  return segments;
}

function renderPatternClauseLines(
  clause: MatchClause,
  operation: string,
  allowDuplicates: boolean,
  matchKeyword: "MATCH" | "OPTIONAL MATCH" = "MATCH"
): string[] {
  const clauseLabel = clause.label || "";
  const clauseIsOptional = matchKeyword === "OPTIONAL MATCH";
  const baseParts: string[] = [];
  const baseWhereBodies: string[] = [];
  const optionalLines: string[] = [];

  (clause.patterns || []).forEach((pattern) => {
    const path = pattern.path || [];
    const split = hopSplit(path, clauseLabel, operation);
    const splitIndex = split ? split.index : -1;
    const basePath = splitIndex < 0 ? path : path.slice(0, splitIndex);
    const baseRendered = renderPath(basePath, clauseLabel, operation);
    if (baseRendered) baseParts.push(baseRendered);
    // A clause-level OPTIONAL MATCH carries its filters inline: the global WHERE
    // renders before it (bound to the last required MATCH) and cannot reference
    // variables bound only in this clause. The same applies to an absent tail's
    // NOT EXISTS body, which references this clause's anchor variable.
    if (clauseIsOptional) {
      basePath.forEach((el) => {
        const body = pathElementWhereBody(el);
        if (body) baseWhereBodies.push(body);
      });
      const absentBody = pathAbsentWhereBody(path, clauseLabel, operation);
      if (absentBody) baseWhereBodies.push(absentBody);
    }
    if (splitIndex < 0 || split?.mode !== "optional") return;
    collectOptionalSegments(path, splitIndex).forEach((segment) => {
      const tail = renderPath(segment.elements, clauseLabel, operation);
      if (!tail) return;
      // Filters on optional-segment entities must ride on their own OPTIONAL MATCH
      // line: in the global WHERE they would drop the rows where the hop is null.
      const whereBodies = segment.elements
        .map((el) => pathElementWhereBody(el))
        .filter(Boolean);
      const whereSuffix = whereBodies.length ? ` WHERE ${whereBodies.join(" AND ")}` : "";
      optionalLines.push(`OPTIONAL MATCH (${segment.anchor})${tail}${whereSuffix}`);
    });
  });

  const patternText = baseParts.length ? baseParts.join(", ") : "()";

  if (operation === "create") {
    const keyword = allowDuplicates ? "CREATE" : "MERGE";
    return [`${keyword} ${patternText}`];
  }

  const baseWhere = baseWhereBodies.length ? ` WHERE ${baseWhereBodies.join(" AND ")}` : "";
  return [`${matchKeyword} ${patternText}${baseWhere}`, ...optionalLines];
}

function renderCreateClauseLines(clause: MatchClause, allowDuplicates: boolean): string[] {
  const clauseLabel = clause.label || "";
  const keyword = allowDuplicates ? "CREATE" : "MERGE";
  const lines: string[] = [];
  const patterns = clause.patterns || [];
  patterns.forEach((pattern, patternIndex) => {
    const path = pattern.path || [];
    const parts = collectExistingNodeMatches(path, clauseLabel, patterns, patternIndex);
    const mergePath = renderPath(path, clauseLabel, "create");
    if (mergePath) parts.push(`${keyword} ${mergePath}`);
    if (parts.length) lines.push(parts.join(" "));
  });
  if (!lines.length && !(clause.patterns || []).length) {
    lines.push(`${keyword} ()`);
  }
  return lines;
}

export function renderMatchClauses(
  match: MatchClause[] | null | undefined,
  operation: string,
  allowDuplicates: boolean
): string[] {
  if (operation === "create") {
    return (match || []).flatMap((clause) => renderCreateClauseLines(clause, allowDuplicates));
  }

  // Neo4j requires OPTIONAL MATCH to follow a prior MATCH/WITH — never start a query with it.
  let hasPriorMatch = false;
  return (match || []).flatMap((clause) => {
    const matchKeyword: "MATCH" | "OPTIONAL MATCH" =
      clause.optional && hasPriorMatch ? "OPTIONAL MATCH" : "MATCH";
    hasPriorMatch = true;
    return renderPatternClauseLines(clause, operation, allowDuplicates, matchKeyword);
  });
}
