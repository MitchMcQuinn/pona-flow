import {
  bindingForVariable,
  parseReadReturnExpression,
  type ReadMatchPathBinding
} from "@pona-flow/authoring";
import type { OrderByItem } from "./types";

/** Build the `variable.property` ORDER BY expression, or "" when incomplete. */
export function orderByExpression(pathVariable: string, propertyKey: string): string {
  const v = pathVariable.trim();
  const k = propertyKey.trim();
  if (!v || !k) return "";
  return `${v}.${k}`;
}

/**
 * Resolve the schema (path variable) and property for an ORDER BY item, preferring
 * the stored builder hints and falling back to parsing `alias.property` against the
 * current match bindings (so reloaded literal expressions still populate the pickers).
 */
export function resolvedOrderByFields(
  item: OrderByItem,
  bindings: ReadMatchPathBinding[]
): {
  path_variable: string;
  property_key: string;
  attributive_label: string;
  entityRole: "node" | "relationship";
} {
  let path_variable = (item.path_variable || "").trim();
  let property_key = (item.property_key || "").trim();
  if (!path_variable || !property_key) {
    const parsed = parseReadReturnExpression(item.expression, bindings);
    if (parsed) {
      path_variable = parsed.path_variable;
      property_key = parsed.property_key;
    }
  }
  const binding = bindingForVariable(bindings, path_variable);
  return {
    path_variable,
    property_key,
    attributive_label: binding?.attributive_label ?? (item.attributive_label || "").trim(),
    entityRole: binding?.entityRole ?? item.entity_role ?? "node"
  };
}

/** Patch carrying the picker selections plus the composed expression for the composer. */
export function orderByItemPatch(
  bindings: ReadMatchPathBinding[],
  pathVariable: string,
  propertyKey: string
): Partial<OrderByItem> {
  const binding = bindingForVariable(bindings, pathVariable);
  return {
    path_variable: pathVariable.trim() || undefined,
    property_key: propertyKey.trim() || undefined,
    attributive_label: binding?.attributive_label,
    entity_role: binding?.entityRole,
    expression: orderByExpression(pathVariable, propertyKey)
  };
}
