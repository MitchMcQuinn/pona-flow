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
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

/**
 * Live-typing sanitizer for free-text attributive_label inputs. While the value
 * begins with "$" it is treated as an in-progress parameter (keep "$" + identifier
 * characters) so the user can start typing a parameter; otherwise it normalizes to
 * a literal attributive_label. Unlike `normalizeAttributiveLabel`, this preserves a
 * lone or partial "$name" instead of stripping the leading "$".
 */
export function sanitizeAttributiveLabelInput(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith("$")) {
    return "$" + trimmed.slice(1).replace(/[^A-Za-z0-9_]/g, "");
  }
  return normalizeAttributiveLabel(value);
}

/** SCHEMA property name/key: same UPPER_SNAKE rules as attributive_label (incl. $param). */
export const normalizeSchemaPropertyKey = normalizeAttributiveLabel;

/** Live-typing sanitizer for SCHEMA property name inputs. */
export const sanitizeSchemaPropertyKeyInput = sanitizeAttributiveLabelInput;

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
