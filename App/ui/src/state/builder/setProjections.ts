import composer from "../../services/composer";
import {
  bindingForVariable,
  type ReadMatchPathBinding
} from "@pona-flow/authoring";
import type { SetItem, SetValueMode } from "./types";

// Matches a value that is exactly a parameter reference, e.g. "$personName".
const PARAM_REF_EXACT_RE = /^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$/;

/** True when a SET value is a single parameter reference ($name) rather than a literal. */
export function isSetValueParameter(value: string | undefined): boolean {
  return PARAM_REF_EXACT_RE.test(String(value ?? "").trim());
}

// Coerce a raw value string to the closest scalar so literal formatting quotes
// strings but leaves numbers/booleans/null bare (mirrors the WHERE filter logic).
function parseSetValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

/** Render a raw value as Cypher: a $parameter stays bare, everything else is a literal. */
export function formatSetValue(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  if (isSetValueParameter(t)) return t;
  return composer.formatLiteral(parseSetValue(t));
}

export function buildSetExpression(
  pathVariable: string,
  propertyKey: string,
  rawValue: string
): string {
  const v = pathVariable.trim();
  const k = propertyKey.trim();
  const formatted = formatSetValue(rawValue);
  if (!v || !k || !formatted) return "";
  return `${v}.${k} = ${formatted}`;
}

/** Inputs a SET row's right-hand side may draw from, depending on its mode. */
export interface SetExpressionInputs {
  mode: SetValueMode;
  /** literal: raw value/$param. expression: raw Cypher right-hand side. */
  rawValue?: string;
  /** not_property: in-scope alias whose boolean property is negated. */
  sourceVariable?: string;
  /** not_property: the negated boolean property. */
  sourceProperty?: string;
}

/**
 * Compile one SET assignment for its authoring mode. `expression` stays the sole
 * compiled artifact (composeQuery joins these verbatim); an incomplete row compiles
 * to "" which validateQuery's empty-expression check reports.
 */
export function buildSetExpressionForMode(
  pathVariable: string,
  propertyKey: string,
  inputs: SetExpressionInputs
): string {
  const v = pathVariable.trim();
  const k = propertyKey.trim();
  if (!v || !k) return "";
  switch (inputs.mode) {
    case "now":
      return `${v}.${k} = toString(datetime())`;
    case "not_property": {
      const source = (inputs.sourceVariable ?? "").trim();
      const property = (inputs.sourceProperty ?? "").trim();
      if (!source || !property) return "";
      return `${v}.${k} = (NOT coalesce(${source}.${property}, false))`;
    }
    case "expression": {
      const rhs = (inputs.rawValue ?? "").trim();
      if (!rhs) return "";
      return `${v}.${k} = ${rhs}`;
    }
    default:
      return buildSetExpression(v, k, inputs.rawValue ?? "");
  }
}

/** Parse a legacy `alias.property = value` assignment when alias matches a binding. */
function parseSetExpression(
  expression: string,
  bindings: ReadMatchPathBinding[]
): { path_variable: string; property_key: string; value: string } | null {
  const match = expression
    .trim()
    .match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
  if (!match) return null;
  const path_variable = match[1];
  const property_key = match[2];
  if (!bindingForVariable(bindings, path_variable)) return null;
  let value = match[3].trim();
  // Best-effort unquote so the value field shows the literal the user typed.
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
  return { path_variable, property_key, value };
}

export function resolvedSetFields(
  item: SetItem,
  bindings: ReadMatchPathBinding[]
): {
  path_variable: string;
  property_key: string;
  value: string;
  attributive_label: string;
  entityRole: "node" | "relationship";
  value_mode: SetValueMode;
  source_variable: string;
  source_property: string;
} {
  let path_variable = (item.path_variable || "").trim();
  let property_key = (item.property_key || "").trim();
  let value = item.value ?? "";
  if (!path_variable || !property_key) {
    const parsed = parseSetExpression(item.expression, bindings);
    if (parsed) {
      path_variable = parsed.path_variable;
      property_key = parsed.property_key;
      if (item.value == null) value = parsed.value;
    }
  }
  const binding = bindingForVariable(bindings, path_variable);
  return {
    path_variable,
    property_key,
    value,
    attributive_label: binding?.attributive_label ?? (item.attributive_label || "").trim(),
    entityRole: binding?.entityRole ?? item.entity_role ?? "node",
    value_mode: item.value_mode ?? "literal",
    source_variable: (item.source_variable || "").trim(),
    source_property: (item.source_property || "").trim()
  };
}

export function setItemPatch(
  bindings: ReadMatchPathBinding[],
  pathVariable: string,
  propertyKey: string,
  rawValue: string,
  inputs: Partial<SetExpressionInputs> = {}
): Partial<SetItem> {
  const mode: SetValueMode = inputs.mode ?? "literal";
  const binding = bindingForVariable(bindings, pathVariable);
  const sourceVariable =
    mode === "not_property" ? (inputs.sourceVariable ?? "").trim() || undefined : undefined;
  const sourceProperty =
    mode === "not_property" ? (inputs.sourceProperty ?? "").trim() || undefined : undefined;
  return {
    path_variable: pathVariable.trim() || undefined,
    property_key: propertyKey.trim() || undefined,
    attributive_label: binding?.attributive_label,
    entity_role: binding?.entityRole,
    value: rawValue,
    // "literal" stays unset so pre-existing configs re-save byte-identically.
    value_mode: mode === "literal" ? undefined : mode,
    source_variable: sourceVariable,
    source_property: sourceProperty,
    expression: buildSetExpressionForMode(pathVariable, propertyKey, {
      mode,
      rawValue,
      sourceVariable,
      sourceProperty
    })
  };
}
