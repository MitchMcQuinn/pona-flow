/** Cypher and SQLite literal formatting. */

export function escapeCypherString(value: unknown): string {
  return (
    "'" +
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'") +
    "'"
  );
}

export function formatLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return escapeCypherString(value);
  return escapeCypherString(JSON.stringify(value));
}

export function formatExistsRhs(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return escapeCypherString(value);
  return escapeCypherString(JSON.stringify(value));
}

export function escapeSqliteString(value: unknown): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Exact ``$name`` parameter reference (excludes ``$1``/``${1}``/``$secret.X``). */
const EXACT_PARAM_REF_RE = /^\$(?![0-9])([A-Za-z_][A-Za-z0-9_]*)$/;

/** Parameter name when the value is exactly ``$name``, else null. */
export function exactParameterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = EXACT_PARAM_REF_RE.exec(value.trim());
  return match ? match[1] : null;
}

export function renderLiteralOrParameter(
  ref: { parameter?: string; value?: unknown } | null | undefined
): string {
  if (!ref) return "";
  if (ref.parameter) return `$${ref.parameter}`;
  if (ref.value !== undefined && ref.value !== null && ref.value !== "") return String(ref.value);
  return "";
}
