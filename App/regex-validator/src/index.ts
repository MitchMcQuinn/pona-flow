/**
 * Validates string values against regex patterns from the catalog regex table.
 * Patterns are loaded via setPatterns(rows) from the authenticated /api/regex route.
 */

export interface RegexPatternRow {
  name: string;
  regex?: string | null;
}

export interface RegexValidationResult {
  valid: boolean;
  skipped?: boolean;
  error?: string;
}

const patternsByName = new Map<string, string>();

export function setPatterns(rows: RegexPatternRow[] | null | undefined): void {
  patternsByName.clear();
  for (const row of rows || []) {
    const name = (row?.name ?? "").trim();
    if (!name) continue;
    patternsByName.set(name, row.regex == null ? "" : String(row.regex));
  }
}

export function getPattern(formatName: string): string {
  const name = (formatName ?? "").trim();
  if (!name) return "";
  return patternsByName.get(name) ?? "";
}

export function validate(formatName: string, value: string): RegexValidationResult {
  const fmt = (formatName ?? "").trim();
  if (!fmt || fmt === "any") return { valid: true, skipped: true };

  const raw = String(value ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "null") {
    return { valid: true, skipped: true };
  }

  const pattern = getPattern(fmt);
  if (!pattern) return { valid: true, skipped: true };

  try {
    const re = new RegExp(pattern);
    return { valid: re.test(raw) };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "Invalid regex pattern",
    };
  }
}

export interface RegexValidatorApi {
  setPatterns(rows: RegexPatternRow[]): void;
  getPattern(formatName: string): string;
  validate(formatName: string, value: string): RegexValidationResult;
}

export const regexValidator: RegexValidatorApi = {
  setPatterns,
  getPattern,
  validate,
};

export default regexValidator;
