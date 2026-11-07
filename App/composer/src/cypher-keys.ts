/** Cypher property key escaping and property map rendering. */

import { formatLiteral } from "./literals.js";

export function cypherPropertyKey(key: unknown): string {
  const k = String(key || "");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return k;
  return "`" + k.replace(/`/g, "``") + "`";
}

export function cypherNodePropertyRef(variable: string, key: unknown): string {
  const k = String(key || "");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `${variable}.${k}`;
  return `${variable}.\`${k.replace(/`/g, "``")}\``;
}

/**
 * Builder fields and chat applies hand property values over as strings. Render a
 * boolean as a Cypher boolean, and an integer or number as a numeric literal, so
 * the graph stores the declared type. A later `+` on a quoted integer concatenates
 * text instead of adding. Text that is not a literal of that type stays quoted.
 */
function literalForDeclaredType(
  value: unknown,
  schematic: { value_type?: string } | undefined
): unknown {
  if (typeof value !== "string") return value;
  const valueType = schematic?.value_type;
  if (valueType === "boolean") {
    const t = value.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
    return value;
  }
  if (valueType === "integer" || valueType === "number") return numericLiteral(value, valueType);
  return value;
}

function numericLiteral(value: string, valueType: "integer" | "number"): number | string {
  const text = value.trim();
  if (!text) return value;
  if (valueType === "integer") {
    if (!/^-?\d+$/.test(text)) return value;
    return Number.parseInt(text, 10);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return value;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : value;
}

export function renderPropertyMap(
  properties:
    | Array<{
        key?: string;
        parameter?: string;
        value?: unknown;
        schematic_properties?: { value_type?: string };
      }>
    | null
    | undefined
): string {
  if (!properties || !properties.length) return "";
  const parts = properties
    .filter((p) => p && p.key)
    .map((p) => {
      const ck = cypherPropertyKey(p.key);
      if (p.parameter) return `${ck}: $${p.parameter}`;
      return `${ck}: ${formatLiteral(literalForDeclaredType(p.value, p.schematic_properties))}`;
    });
  if (!parts.length) return "";
  return ` { ${parts.join(", ")} }`;
}
