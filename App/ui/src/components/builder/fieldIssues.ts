/** Maps a builder warning onto the field it is about, when it has one. */
export function issueKeyForWarning(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes("attributive_label")) return "attributive_label";
  if (text.includes("empty projection") || (text.includes("projection") && text.includes("expression"))) {
    return "return-expression";
  }
  if (text.includes("projection") && text.includes("alias")) return "return-alias";
  if (text.includes("comparison operator")) return "return-operator";
  if (text.includes("value to compare")) return "return-value";
  if (text.includes("set expression")) return "set-expression";
  if (text.includes("target variable")) return "delete-target";
  if (text.includes("search text")) return "vector-text";
  if (text.includes("vector search k")) return "vector-k";
  if (text.includes("endpoint")) return "step-endpoint";
  if (text.includes("request body") || text.includes("valid json") || text.includes("requires a body")) {
    return "step-body";
  }
  if (text.includes("parameter") && (text.includes("default") || text.includes("reserved"))) {
    return "parameter-name";
  }
  return null;
}

export function partitionWarnings(messages: string[]): { issueClasses: string[]; unmatched: string[] } {
  const keys = new Set<string>();
  const unmatched: string[] = [];
  for (const message of messages) {
    const key = issueKeyForWarning(message);
    if (key) keys.add(key);
    else unmatched.push(message);
  }
  return { issueClasses: [...keys].map((key) => `issue-${key}`), unmatched };
}
