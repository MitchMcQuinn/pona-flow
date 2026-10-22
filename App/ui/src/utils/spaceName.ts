/** Leave the typed name intact. The catalog id is derived separately. */
export function sanitizeSpaceNameInput(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Catalog space id / env-key prefix: uppercase, spaces → underscores, alphanumeric
 * + underscores only (e.g. "Test space" → "TEST_SPACE").
 */
export function normalizeSpaceName(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  text = text.toUpperCase().replace(/\s+/g, "_");
  text = text.replace(/[^A-Z0-9_]/g, "");
  text = text.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return text;
}

export function isValidSpaceNameInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return normalizeSpaceName(trimmed).length > 0;
}
