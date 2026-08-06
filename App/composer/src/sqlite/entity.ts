/** SQLite entities table INSERT/UPDATE/DELETE for STEP and SCHEMA graph operations.

INSTANCE data lives in Neo4j only — it is not mirrored into the entities table.
 */

import { escapeSqliteString } from "../literals.js";
import { entityIdLiteral, nodeIdLiteral } from "../entity/ids.js";
import { commonLabelForEntity } from "../entity/labels.js";
import { isExistingGraphNode } from "../entity/predicates.js";
import { schemaPayloadFromProperties, schemaRelPayload, stepRelPayload } from "../schema/payload.js";
import { stepEntityPayload } from "../step/endpoint.js";
import { entityParametersSql } from "../step/parameters.js";
import type { NodePattern, QueryObject, RelationshipPattern } from "../types.js";

export function composeEntitySqlite(query: QueryObject, operation?: string): string[] {
  const op = operation || (query && query.operation) || "read";
  if (op === "delete") {
    // Mirror only the variables actually named in DELETE so the graph and entities
    // table stay in sync. With no recorded targets, fall back to every matched
    // entity (legacy behaviour for packages composed before targets were tracked).
    const targetVars = new Set(
      (query.delete?.targets || [])
        .map((t) => String(t ?? "").trim())
        .filter(Boolean)
    );
    const deletes: string[] = [];
    const seen = new Set<string>();
    const pushDelete = (sql: string): void => {
      if (seen.has(sql)) return;
      seen.add(sql);
      deletes.push(sql);
    };
    (query.match || []).forEach((clause) => {
      const label = clause.label || "";
      (clause.patterns || []).forEach((pattern) => {
        (pattern.path || []).forEach((step) => {
          let entity: NodePattern | RelationshipPattern | null = null;
          let variable = "";
          let id: string | null = null;
          if (step.kind === "node" && step.node) {
            entity = step.node;
            variable = String(step.node.variable || "").trim();
            id = nodeIdLiteral(step.node, label);
          } else if (step.kind === "relationship" && step.relationship) {
            entity = step.relationship;
            variable = String(step.relationship.variable || "").trim();
            id = entityIdLiteral(step.relationship, label);
          }
          if (!entity) return;
          if (targetVars.size && (!variable || !targetVars.has(variable))) return;
          // INSTANCE rows are graph-only; nothing to remove from entities.
          if (label === "INSTANCE") return;
          if (id) {
            pushDelete(`DELETE FROM entities WHERE id = ${escapeSqliteString(id)};`);
            return;
          }
          // STEP/SCHEMA entities are matched in the graph by attributive_label
          // (there is no literal id), which maps to the entities common_label — so
          // delete the entities-table counterpart by its (label, common_label).
          if (label === "STEP" || label === "SCHEMA") {
            const commonLabel = commonLabelForEntity(entity, label);
            if (commonLabel) {
              pushDelete(
                `DELETE FROM entities WHERE node_label = '${label}' AND common_label = ${escapeSqliteString(
                  commonLabel
                )};`
              );
            }
          }
        });
      });
    });
    return deletes;
  }
  if (op !== "create" && op !== "update") return [];

  // SCHEMA/STEP config updates target existing entities by id (node_source
  // "existing"), so the usual "skip existing graph nodes" guard is lifted for them.
  const entityConfigUpdate = op === "update";

  const statements: string[] = [];
  (query.match || []).forEach((clause) => {
    const label = clause.label || "";
    const isConfigUpdateLabel = entityConfigUpdate && (label === "STEP" || label === "SCHEMA");
    // INSTANCE payloads are stored on graph nodes only, not in entities.
    if (label === "INSTANCE") return;
    (clause.patterns || []).forEach((pattern) => {
      (pattern.path || []).forEach((step) => {
        if (step.kind === "node" && step.node) {
          if (step.node.alias_mode === "reference") return;
          if (isExistingGraphNode(step.node) && !isConfigUpdateLabel) return;
          const id = nodeIdLiteral(step.node, label);
          if (!id) return;
          const idSql = escapeSqliteString(id);
          let payloadSql: string | null = null;
          if (label === "STEP") {
            payloadSql = escapeSqliteString(stepEntityPayload(step.node.sequencial_properties));
          } else if (label === "SCHEMA") {
            payloadSql = escapeSqliteString(schemaPayloadFromProperties(step.node.properties || []));
          } else {
            return;
          }
          const paramsSql = entityParametersSql(
            query,
            label,
            label === "STEP" ? step.node.sequencial_properties : null
          );
          if (op === "create") {
            const commonLabelSql = escapeSqliteString(commonLabelForEntity(step.node, label));
            statements.push(
              `INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) VALUES (${idSql}, '${label}', ${commonLabelSql}, ${paramsSql}, ${payloadSql}, datetime('now'), datetime('now'));`
            );
          } else {
            statements.push(
              `UPDATE entities SET parameters = ${paramsSql}, payload = ${payloadSql}, modified_date = datetime('now') WHERE id = ${idSql};`
            );
          }
        } else if (step.kind === "relationship" && step.relationship) {
          if (step.relationship.alias_mode === "reference") return;
          const id = entityIdLiteral(step.relationship, label);
          if (!id) return;
          let payloadSql: string | null = null;
          if (label === "STEP") {
            payloadSql = escapeSqliteString(stepRelPayload(step.relationship));
          } else if (label === "SCHEMA") {
            payloadSql = escapeSqliteString(schemaRelPayload(step.relationship));
          } else {
            return;
          }
          const idSql = escapeSqliteString(id);
          const labelSql = label === "STEP" ? "STEP" : "SCHEMA";
          const relParamsSql = entityParametersSql(query, label, null);
          if (op === "create") {
            const commonLabelSql = escapeSqliteString(commonLabelForEntity(step.relationship, label));
            statements.push(
              `INSERT INTO entities (id, node_label, common_label, parameters, payload, creation_date, modified_date) VALUES (${idSql}, '${labelSql}', ${commonLabelSql}, ${relParamsSql}, ${payloadSql}, datetime('now'), datetime('now'));`
            );
          } else if (label === "SCHEMA" && commonLabelForEntity(step.relationship, label)) {
            // A SCHEMA relationship attributive_label is a reusable type: every edge sharing
            // it carries an identical payload copy, so updates target all copies by
            // common_label to keep them in sync (STEP relationships stay id-keyed — their
            // labels may repeat with independent payloads).
            const commonLabelSql = escapeSqliteString(commonLabelForEntity(step.relationship, label));
            statements.push(
              `UPDATE entities SET parameters = ${relParamsSql}, payload = ${payloadSql}, modified_date = datetime('now') WHERE node_label = 'SCHEMA' AND common_label = ${commonLabelSql};`
            );
          } else {
            statements.push(
              `UPDATE entities SET parameters = ${relParamsSql}, payload = ${payloadSql}, modified_date = datetime('now') WHERE id = ${idSql};`
            );
          }
        }
      });
    });
  });
  return statements;
}

export function composeStepEntitySqlite(query: QueryObject, operation?: string): string[] {
  return composeEntitySqlite(query, operation);
}
