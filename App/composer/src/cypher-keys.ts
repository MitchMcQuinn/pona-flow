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
 * A boolean-declared property authored in the builder arrives as the string
 * "true"/"false"; render it as a Cypher boolean literal so the stored graph value
 * matches boolean WHERE filters. Other value types pass through unchanged.
 */
function literalForDeclaredType(
  value: unknown,
  schematic: { value_type?: string } | undefined
): unknown {
  if (schematic?.value_type !== "boolean" || typeof value !== "string") return value;
  const t = value.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return value;
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
