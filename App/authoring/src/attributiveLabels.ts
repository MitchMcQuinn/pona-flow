import type { QueryObject } from "./types.js";

/**
 * Entities a create package is actually writing. Alias references and matched-existing
 * endpoints are in the pattern so the composer can MERGE an edge onto them, but they
 * already own their attributive_label — claiming those labels as "new" makes the server
 * uniqueness gate reject a self-referential SCHEMA relationship (or a STEP transition)
 * as a collision with the node the author just selected.
 */
function isWrittenCreateEntity(entity: {
  alias_mode?: string;
  node_source?: string;
}): boolean {
  return entity.alias_mode !== "reference" && entity.node_source !== "existing";
}

function collectFromQuery(
  query: QueryObject,
  clauseLabel: "STEP" | "SCHEMA"
): string[] {
  const out = new Set<string>();
  if (query.operation !== "create" || query.match[0]?.label !== clauseLabel) return [];

  const add = (entity: {
    attributive_label?: string;
    alias_mode?: string;
    node_source?: string;
  }) => {
    if (!isWrittenCreateEntity(entity)) return;
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

/**
 * Graph ids of every entity a create package writes. The server pairs these with
 * `collectCreateAttributiveLabels` to tell a re-save of the caller's own entity apart
 * from a collision with somebody else's.
 */
export function collectCreateEntityIds(query: QueryObject): string[] {
  const out = new Set<string>();
  if (query.operation !== "create") return [];

  const add = (entity: {
    alias_mode?: string;
    node_source?: string;
    id_binding?: { value?: unknown };
  }) => {
    if (!isWrittenCreateEntity(entity)) return;
    const id = String(entity.id_binding?.value ?? "").trim();
    // A `$param` id is minted at run time and cannot pre-own a label.
    if (id && !id.startsWith("$")) out.add(id);
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
