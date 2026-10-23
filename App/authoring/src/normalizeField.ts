// Live input normalization for attributive_label and alias fields (create STEP/SCHEMA flows).

/** Exact parameter reference ($name) allowed in an attributive_label field. */
export const ATTRIBUTIVE_LABEL_PARAMETER_RE = /^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$/;

/** True when value is exactly a parameter reference (e.g. "$companyType"). */
export function isAttributiveLabelParameter(value: string): boolean {
  return ATTRIBUTIVE_LABEL_PARAMETER_RE.test(String(value ?? "").trim());
}

export function normalizeAttributiveLabel(value: string): string {
  const trimmed = String(value ?? "").trim();
  // Preserve a complete parameter reference verbatim ($name); composer emits it as $param.
  if (isAttributiveLabelParameter(trimmed)) return trimmed;
  return String(value ?? "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Live-typing sanitizer for free-text attributive_label inputs. Lowercase only;
 * spaces stay so a display name can be typed. While the value begins with "$"
 * it is treated as an in-progress parameter (keep "$" + identifier characters).
 */
export function sanitizeAttributiveLabelInput(value: string): string {
  const raw = String(value ?? "");
  if (raw.trimStart().startsWith("$")) {
    return "$" + raw.trim().replace(/^\$/, "").replace(/[^A-Za-z0-9_]/g, "");
  }
  return raw.toLowerCase().replace(/[^a-z0-9_ ]/g, "").replace(/^ +/, "");
}

/** Commit form of a typed attributive_label: lowercase, trimmed, internal spaces kept. */
export function finalizeAttributiveLabelInput(value: string): string {
  const sanitized = sanitizeAttributiveLabelInput(value);
  if (isAttributiveLabelParameter(sanitized.trim())) return sanitized.trim();
  return sanitized.replace(/ +/g, " ").trim();
}

/** SCHEMA property name/key: lowercase snake_case (spaces become `_`; $param is preserved). */
export function normalizeSchemaPropertyKey(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (isAttributiveLabelParameter(trimmed)) return trimmed;
  return String(value ?? "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

/** Live-typing sanitizer for SCHEMA property name inputs. */
export function sanitizeSchemaPropertyKeyInput(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith("$")) {
    return "$" + trimmed.slice(1).replace(/[^A-Za-z0-9_]/g, "");
  }
  return normalizeSchemaPropertyKey(value);
}

/**
 * Enforce parameter formatting for a field that must hold a $parameter reference
 * (e.g. a property whose schema is itself a parameter): strips invalid characters
 * and any stray "$", drops a leading digit, then re-adds a single leading "$".
 * Empty input stays empty so the placeholder shows.
 */
export function formatParameterInput(value: string): string {
  const body = String(value ?? "")
    .trim()
    .replace(/\$/g, "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^[0-9]+/, "");
  return body ? `$${body}` : "";
}

export function normalizeAlias(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^[^A-Za-z]+/, "");
}

export const ALIAS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export const ALIAS_NAME_ERROR_MSG =
  "Alias must start with a letter and contain only letters, numbers, and underscores.";

/** Validate an optional alias (empty/whitespace is allowed). */
export function validateOptionalAlias(value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  if (!ALIAS_NAME_PATTERN.test(trimmed)) return ALIAS_NAME_ERROR_MSG;
  return null;
}
