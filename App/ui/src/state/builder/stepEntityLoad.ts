import { newSchematicProperties } from "./defaults";
import { addPathRelAndNode, updateNode, updateRelationship } from "./queryHelpers";
import type { Parameter, QueryObject, RelationshipPattern, ValueType } from "./types";
import type { GraphNodeRow, StepOutgoingEdge } from "../../services/connector";

const VALUE_TYPES: ValueType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "UID",
  "radio",
  "checkbox"
];

function toValueType(raw: unknown): ValueType {
  const t = String(raw ?? "").trim();
  return (VALUE_TYPES as string[]).includes(t) ? (t as ValueType) : "string";
}

function toOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v ?? "").trim()).filter((v) => v !== "");
}

function toCount(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.trunc(raw);
}

/**
 * Convert a STEP entity's stored ``parameters`` rows (from the entities table) into
 * editable builder parameters, so an existing custom-endpoint step's input parameters
 * (and their value_type/format/required metadata) survive a load → edit → re-save.
 */
export function parametersFromEntityRows(
  rows: Array<Record<string, unknown>> | undefined
): Parameter[] {
  return (rows || [])
    .map((row): Parameter | null => {
      const name = String(row.name ?? "").trim();
      if (!name) return null;
      const value_type = toValueType(row.value_type);
      const format = typeof row.format === "string" ? row.format : undefined;
      const isChoice = value_type === "radio" || value_type === "checkbox";
      return {
        name,
        data_type: "string",
        value: row.value ?? "",
        is_required: Boolean(row.is_required),
        schematic_properties: {
          ...newSchematicProperties(),
          value_type,
          format: value_type === "string" ? format ?? "any" : undefined,
          is_required: Boolean(row.is_required),
          ...(isChoice ? { options: toOptions(row.options) } : {}),
          ...(value_type === "checkbox" ? { min_choices: toCount(row.min_choices) } : {}),
          ...(value_type === "checkbox" ? { max_choices: toCount(row.max_choices) } : {})
        }
      };
    })
    .filter((p): p is Parameter => p !== null);
}

/**
 * Query updater that loads an existing custom-endpoint STEP node into a match-clause position:
 * binds it by graph id (alias-locked), carries its sequencial_properties, and merges its stored
 * input parameters into the query. Shared by the update-STEP node picker and the visualizer
 * "click a STEP node → edit it" jump so both load an entity identically.
 */
export function loadStepNodeIntoQuery(
  row: GraphNodeRow,
  address: { clauseIndex: number; patternIndex: number; pathIndex: number }
) {
  return (q: QueryObject): QueryObject => {
    let next = updateNode(address.clauseIndex, address.patternIndex, address.pathIndex, {
      attributive_label: row.attributive_label,
      node_source: "existing",
      id_binding: { key: "id", value: row.id },
      variable: row.id,
      alias_locked: true,
      sequencial_properties: row.sequencial_properties ?? {},
      properties: []
    })(q);
    next = mergeEntityParameters(next, row.parameters);
    return next;
  };
}

/** Merge a STEP entity's stored input parameters into the query (existing names win on key). */
function mergeEntityParameters(
  query: QueryObject,
  rows: GraphNodeRow["parameters"]
): QueryObject {
  const loaded = parametersFromEntityRows(rows);
  if (!loaded.length) return query;
  const byName = new Map(query.parameters.map((p) => [p.name, p]));
  loaded.forEach((p) => byName.set(p.name, p));
  return { ...query, parameters: Array.from(byName.values()) };
}

/**
 * Query updater that loads a STEP POINTS_TO relationship into a match clause as a full
 * `(start)-[rel]->(end)` path so the update-STEP flow can edit the relationship's config (its
 * guard condition). The builder can't display a relationship without its supporting start/end
 * nodes, so this binds all three by graph id (alias-locked) and carries the relationship's stored
 * condition plus each node's sequencial_properties / input parameters. Mirrors the edge-load that
 * `selectConfigStepRel` performs when a relationship is picked manually in the builder.
 */
export function loadStepRelationshipIntoQuery(
  startRow: GraphNodeRow,
  edge: StepOutgoingEdge,
  targetRow: GraphNodeRow | undefined,
  address: { clauseIndex: number; patternIndex: number }
) {
  return (q: QueryObject): QueryObject => {
    const { clauseIndex, patternIndex } = address;
    // Extend the pattern path to [node, relationship, node] before binding each element.
    let next = addPathRelAndNode(clauseIndex, patternIndex)(q);
    next = loadStepNodeIntoQuery(startRow, { clauseIndex, patternIndex, pathIndex: 0 })(next);
    next = updateRelationship(clauseIndex, patternIndex, 1, {
      attributive_label: edge.rel_attributive_label,
      node_source: "existing",
      id_binding: { key: "id", value: edge.rel_id },
      variable: edge.rel_id,
      alias_locked: true,
      condition_type: (edge.condition_type as RelationshipPattern["condition_type"]) || "null",
      condition: edge.condition || "",
      condition_expected: edge.condition_expected,
      properties: []
    })(next);
    next = updateNode(clauseIndex, patternIndex, 2, {
      attributive_label: edge.target_attributive_label,
      node_source: "existing",
      id_binding: { key: "id", value: edge.target_id },
      variable: edge.target_id,
      alias_locked: true,
      sequencial_properties: targetRow?.sequencial_properties ?? {},
      properties: []
    })(next);
    next = mergeEntityParameters(next, targetRow?.parameters);
    return next;
  };
}
