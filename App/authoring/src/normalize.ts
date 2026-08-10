/**
 * Last-mile QueryObject shaping applied immediately before composition.
 *
 * The composer is deliberately literal: it renders what the QueryObject says. A few
 * authoring affordances (structured Cypher condition builders, label-only STEP/SCHEMA
 * matches, implicit DETACH DELETE) are expressed at the authoring layer and have to be
 * lowered into plain QueryObject fields here, or the composed statements will not match
 * what the author asked for.
 */

import { composer } from "@pona-flow/composer";
import { isLabelOnlyDelete, isLabelOnlyMatch } from "./matchMode.js";
import { collectDeleteTargetBindings } from "./returnProjections.js";
import type { PathElement, QueryObject } from "./types.js";

// Relationships built with a cypher condition store the structured builder, but
// the composer reads a precomputed `condition` string. Derive it before composing.
export function normalizeForCompose(query: QueryObject): QueryObject {
  // Read/delete STEP/SCHEMA targets matched entities by attributive_label only: strip any
  // residual per-path WHERE filters so no stray predicate composes. Delete additionally
  // (below) replaces the DELETE clause with a DETACH DELETE of every MATCH variable.
  const labelOnlyMatch = isLabelOnlyMatch(query.operation, query.match[0]?.label);
  const labelOnlyDelete = isLabelOnlyDelete(query.operation, query.match[0]?.label);

  const normalized: QueryObject = {
    ...query,
    match: query.match.map((clause) => ({
      ...clause,
      patterns: clause.patterns.map((pattern) => ({
        ...pattern,
        path: pattern.path.map((element): PathElement => {
          if (element.kind === "relationship") {
            let rel = element.relationship;
            if (rel.condition_type === "cypher" && rel.cypher_condition) {
              rel = {
                ...rel,
                condition: composer.buildExistsInstanceCondition(rel.cypher_condition)
              };
            }
            if (labelOnlyMatch) {
              rel = { ...rel, where: undefined, where_enabled: false };
            }
            return { kind: "relationship", relationship: rel };
          }
          if (labelOnlyMatch && element.kind === "node") {
            return {
              kind: "node",
              node: { ...element.node, where: undefined, where_enabled: false }
            };
          }
          return element;
        })
      }))
    }))
  };

  if (labelOnlyDelete) {
    const targets = collectDeleteTargetBindings(normalized)
      .map((binding) => binding.variable.trim())
      .filter(Boolean);
    normalized.delete = { detach: true, targets };
  }

  return normalized;
}

/** Graph element the query primarily writes; drives RBAC flow checks and catalog metadata. */
export function primaryNodeLabel(query: QueryObject): string {
  return query.match[0]?.label ?? "STEP";
}

/** Split the composer's single Cypher string into the statement array the API expects. */
export function splitCypher(cypher: string): string[] {
  return cypher
    .split(/\s*;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
