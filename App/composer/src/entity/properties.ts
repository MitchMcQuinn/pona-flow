/** Node/relationship property lists for Cypher patterns. */

import { GRAPH_PAYLOAD_LABELS } from "../constants.js";
import { instanceCreateIdParamName, nodeIdLiteral } from "./ids.js";
import type { GraphNodeLabel, NodePattern, PropertyBinding, RelationshipPattern } from "../types.js";

type EntityLike = NodePattern | RelationshipPattern;

interface PropertyOpts {
  clauseLabel?: GraphNodeLabel | string;
  operation?: string;
  graphOnly?: boolean;
  entityKind?: "node" | "relationship";
}

/** Exact ``$name`` parameter reference (excludes ``$1``/``${1}``/``$secret.X``). */
const PROPERTY_PARAM_REF_RE = /^\$(?![0-9])([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * A property value that is exactly ``$name`` is a run-time parameter, not a literal.
 * Mirror the attributive_label convention: convert it to a parameter binding so the
 * Cypher property map emits ``key: $name`` (a bind parameter) instead of a quoted string.
 */
function bindingWithParameterRef(p: PropertyBinding): PropertyBinding {
  if (p.parameter) return p;
  if (typeof p.value === "string") {
    const match = PROPERTY_PARAM_REF_RE.exec(p.value.trim());
    if (match) return { key: p.key, parameter: match[1] };
  }
  return p;
}

export function propertiesWithIdBinding(
  entity: EntityLike | null | undefined,
  opts: PropertyOpts = {}
): PropertyBinding[] {
  const options = opts || {};
  const skipKeys = new Set(["id", "attributive_label"]);
  // Create-INSTANCE entities with an engine-minted id: the graph id and the UID key
  // property both bind the same run-time parameter instead of a save-time literal.
  const autoIdParam =
    options.clauseLabel === "INSTANCE" ? instanceCreateIdParamName(entity, options) : null;
  const props = ((entity && entity.properties) || [])
    .filter((p) => p && p.key && !skipKeys.has(p.key))
    .map((p) =>
      autoIdParam && p.schematic_properties?.is_key && p.schematic_properties.value_type === "UID"
        ? { key: p.key, parameter: autoIdParam, schematic_properties: p.schematic_properties }
        : bindingWithParameterRef(p)
    );
  if (options.clauseLabel === "INSTANCE") {
    if (autoIdParam) {
      props.unshift({ key: "id", parameter: autoIdParam });
    } else {
      const graphId = nodeIdLiteral(entity, "INSTANCE");
      if (graphId) {
        props.unshift({ key: "id", value: graphId });
      }
    }
  } else {
    const binding = entity && entity.id_binding;
    if (binding && binding.key === "id" && binding.value !== undefined && !binding.parameter) {
      props.unshift({ key: "id", value: binding.value });
    }
  }
  if (entity && entity.attributive_label) {
    const al = String(entity.attributive_label).trim();
    const paramMatch = /^\$(?![0-9])([A-Za-z_][A-Za-z0-9_]*)$/.exec(al);
    if (paramMatch) {
      props.unshift({ key: "attributive_label", parameter: paramMatch[1] });
    } else {
      props.unshift({ key: "attributive_label", value: String(entity.attributive_label) });
    }
  }
  if (
    options.graphOnly &&
    options.clauseLabel &&
    GRAPH_PAYLOAD_LABELS.includes(options.clauseLabel as (typeof GRAPH_PAYLOAD_LABELS)[number])
  ) {
    return props.filter(
      (p) =>
        p.key === "id" ||
        p.key === "attributive_label" ||
        (options.clauseLabel === "STEP" &&
          options.entityKind === "relationship" &&
          (p.key === "condition" || p.key === "condition_type"))
    );
  }
  return props;
}

export function relationshipPropertiesForCypher(
  rel: RelationshipPattern | null | undefined,
  opts: PropertyOpts = {}
): PropertyBinding[] {
  const props = propertiesWithIdBinding(rel, { ...opts, entityKind: "relationship" });
  if (rel && rel.condition_type && rel.condition_type !== "null") {
    const hasType = props.some((p) => p && p.key === "condition_type");
    if (!hasType) {
      props.push({ key: "condition_type", value: String(rel.condition_type) });
    }
  }
  if (rel && rel.condition_type && rel.condition_type !== "null" && rel.condition) {
    const hasCondition = props.some((p) => p && p.key === "condition");
    if (!hasCondition) {
      props.push({ key: "condition", value: String(rel.condition) });
    }
  }
  return props;
}

export function nodePropertiesForCypher(
  node: NodePattern | null | undefined,
  opts: PropertyOpts = {}
): PropertyBinding[] {
  return propertiesWithIdBinding(node, { ...opts, entityKind: "node" });
}
