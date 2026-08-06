import type { QueryObject } from "./types";

function collectFromQuery(
  query: QueryObject,
  clauseLabel: "STEP" | "SCHEMA"
): string[] {
  const out = new Set<string>();
  if (query.operation !== "create" || query.match[0]?.label !== clauseLabel) return [];

  const add = (entity: { attributive_label?: string; alias_mode?: string }) => {
    if (entity.alias_mode === "reference") return;
    const al = (entity.attributive_label ?? "").trim();
    if (al) out.add(al);
  };

  query.match.forEach((clause) => {
    clause.patterns.forEach((pattern) => {
      pattern.path.forEach((element) => {
        if (element.kind === "node") add(element.node);
        else add(element.relationship);
      });
    });
  });
  return [...out];
}

export function collectStepCreateAttributiveLabels(query: QueryObject): string[] {
  return collectFromQuery(query, "STEP");
}

export function collectSchemaCreateAttributiveLabels(query: QueryObject): string[] {
  return collectFromQuery(query, "SCHEMA");
}

export function collectCreateAttributiveLabels(query: QueryObject): string[] {
  return [
    ...collectStepCreateAttributiveLabels(query),
    ...collectSchemaCreateAttributiveLabels(query)
  ];
}
