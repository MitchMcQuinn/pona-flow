/**
 * QueryObject factories.
 *
 * These build the declarative shapes the composer consumes. They are deliberately free of
 * browser dependencies so the MCP server can assemble a QueryObject from intent-level tool
 * arguments the same way the builder assembles one from form input. The UI's
 * `initialBuilderState` stays in the UI: it reads localStorage.
 */

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
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
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
