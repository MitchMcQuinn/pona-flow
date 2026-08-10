/**
 * Pick a unique STEP/SCHEMA-style attributive_label when the requested base name is
 * already taken. Appends a sequential suffix starting at 1: FOO -> FOO1 -> FOO2 …
 */
export function nextUniqueAttributiveLabel(
  baseName: string,
  taken: ReadonlySet<string>
): string {
  const base = (baseName || "").trim();
  if (!base) return base;
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(base + String(n))) {
    n += 1;
  }
  return base + String(n);
}
