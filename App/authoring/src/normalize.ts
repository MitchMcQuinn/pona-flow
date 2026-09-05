/**
 * Last-mile QueryObject shaping applied immediately before composition.
 *
 * The composer is deliberately literal: it renders what the QueryObject says. A few
 * authoring affordances (structured Cypher condition builders, label-only STEP/SCHEMA
 * matches, implicit STEP/SCHEMA DELETE targets) are expressed at the authoring layer
 * and have to be lowered into plain QueryObject fields here, or the composed statements
 * will not match what the author asked for.
 */

import { composer } from "@pona-flow/composer";
import { isLabelOnlyDelete, isLabelOnlyMatch } from "./matchMode.js";
import { hasExplicitDeleteTargets, labelOnlyDeleteClause } from "./returnProjections.js";
import type { PathElement, QueryObject } from "./types.js";

// Relationships built with a cypher condition store the structured builder, but
// the composer reads a precomputed `condition` string. Derive it before composing.
export function normalizeForCompose(query: QueryObject): QueryObject {
  // Read/delete STEP/SCHEMA targets matched entities by attributive_label only: strip any
  // residual per-path WHERE filters so no stray predicate composes. Delete additionally
  // fills the DELETE clause when the author has not named targets: hop MATCHes delete
  // only the relationship; a lone node MATCH DETACH DELETEs that node. An explicit
  // target list (Delete card / MCP delete_targets) is left as authored.
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
    // An explicit target list (Delete card / MCP delete_targets) wins: the author
    // may want only one of several matched relationships, or a node instead of
    // the hop. Empty stays the historical default (rels on a hop, else the node).
    if (hasExplicitDeleteTargets(normalized)) {
      const targets = (normalized.delete?.targets ?? [])
        .map((target) => (target || "").trim())
        .filter(Boolean);
      normalized.delete = {
        detach: Boolean(normalized.delete?.detach),
        targets
      };
    } else {
      // A hop MATCH is "delete this POINTS_TO", not "purge the endpoint STEPs".
      // DETACH DELETE of the nodes would also wipe every other edge on them, and
      // the entities mirror would drop the STEP rows those other edges still need.
      normalized.delete = labelOnlyDeleteClause(normalized);
    }
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
