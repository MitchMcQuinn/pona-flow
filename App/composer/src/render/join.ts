/** Join composed Cypher lines and append RETURN * for create statements. */

export function joinComposedCypherLines(lines: string[] | null | undefined, operation: string): string {
  const trimmed = (lines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (operation === "create") {
    return trimmed.join(";\n");
  }
  return trimmed.join("\n");
}

export function appendCreateReturnStar(lines: string[] | null | undefined): void {
  (lines || []).forEach((line, index) => {
    const t = String(line || "").trim();
    if (/^CREATE\s+INDEX\b/i.test(t)) return;
    if (/^(MATCH|MERGE|CREATE)\b/i.test(t) && !/\bRETURN\b/i.test(t)) {
      (lines as string[])[index] = `${t} RETURN *`;
    }
  });
}
