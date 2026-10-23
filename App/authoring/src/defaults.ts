/**
 * QueryObject factories.
 *
 * These build the declarative shapes the composer consumes. They are deliberately free of
 * browser dependencies so the MCP server can assemble a QueryObject from intent-level tool
 * arguments the same way the builder assembles one from form input. The UI's
 * `initialBuilderState` stays in the UI: it reads localStorage.
 */

import { DEFAULT_SCHEMA_LABEL_PROPERTY_NAME } from "./schemaRules.js";
import type {
  GraphNodeLabel,
  GraphPattern,
  MatchClause,
  NodePattern,
  Operation,
  Parameter,
  PropertyBinding,
  QueryObject,
  RelationshipPattern,
  ReturnItem,
  UnwindItem,
  SchematicProperties,
  WhereFilter,
  WhereGroup,
} from "./types.js";

export function newSchematicProperties(): SchematicProperties {
  return {
    value_type: "string",
    format: "any",
    is_required: false,
    is_key: false,
    is_label: false,
    is_indexed: false,
    is_embedded: false
  };
}

// A plain schema property (added via "+ property").
export function newSchemaProperty(): PropertyBinding {
  return { key: "", value: "", schematic_properties: newSchematicProperties() };
}

/** SCHEMA create starts with a NAME property flagged is_label (required by the schema rules). */
export function newSchemaLabelProperty(): PropertyBinding {
  return {
    key: DEFAULT_SCHEMA_LABEL_PROPERTY_NAME,
    value: "",
    schematic_properties: {
      ...newSchematicProperties(),
      is_label: true,
      is_required: true
    }
  };
}

export function defaultSchemaCreateProperties(): PropertyBinding[] {
  return [newSchemaLabelProperty()];
}

/** Seed the first MATCH node of a create-SCHEMA query with the assumed label property. */
export function applySchemaCreateDefaults(
  query: QueryObject,
  operation: Operation,
  label: GraphNodeLabel
): QueryObject {
  if (operation !== "create" || label !== "SCHEMA") return query;
  const clause = query.match[0];
  const pattern = clause?.patterns[0];
  const element = pattern?.path[0];
  if (!clause || !pattern || !element || element.kind !== "node") return query;
  return {
    ...query,
    match: [
      {
        ...clause,
        patterns: [
          {
            ...pattern,
            path: [
              {
                kind: "node",
                node: { ...element.node, properties: defaultSchemaCreateProperties() }
              },
              ...pattern.path.slice(1)
            ]
          },
          ...clause.patterns.slice(1)
        ]
      },
      ...query.match.slice(1)
    ]
  };
}

let varCounter = 0;
let idCounter = 0;

export function nextNodeVariable(): string {
  varCounter += 1;
  return `n${varCounter}`;
}

export function nextRelVariable(): string {
  varCounter += 1;
  return `r${varCounter}`;
}

export function localId(prefix = "q"): string {
  idCounter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${rand}`;
}

export function newNodePattern(): NodePattern {
  return {
    variable: nextNodeVariable(),
    alias_mode: "define",
    properties: []
  };
}

export function newRelationshipPattern(): RelationshipPattern {
  return {
    variable: nextRelVariable(),
    alias_mode: "define",
    type: "POINTS_TO",
    condition_type: "null",
    properties: []
  };
}

export function newPattern(): GraphPattern {
  return { path: [{ kind: "node", node: newNodePattern() }] };
}

export function newMatchClause(label: GraphNodeLabel = "STEP"): MatchClause {
  return { label, optional: false, patterns: [newPattern()] };
}

export function newPropertyBinding(): PropertyBinding {
  return { key: "", value: "" };
}

export function newParameter(): Parameter {
  return { name: "", data_type: "string", value: "", is_required: false };
}

export function newReturnItem(): ReturnItem {
  return { expression: "" };
}

export function newUnwindItem(): UnwindItem {
  return { expression: "" };
}

export function emptyWhereGroup(): WhereGroup {
  return { operator: "AND", items: [] };
}

export function newWhereFilter(): WhereFilter {
  return { property_key: "", operator: "=", value: "" };
}

export function newQuery(operation: Operation = "read"): QueryObject {
  return {
    id: localId("query"),
    name: "",
    operation,
    parameters: [],
    match: [newMatchClause("STEP")],
    where: undefined,
    return: operation === "read" ? { distinct: false, items: [] } : undefined,
    set: operation === "update" ? [{ expression: "" }] : undefined,
    delete: operation === "delete" ? { detach: false, targets: [] } : undefined,
    order_by: undefined,
    skip: null,
    limit: null,
    allow_duplicates: false,
    hide_duplicates: false
  };
}
