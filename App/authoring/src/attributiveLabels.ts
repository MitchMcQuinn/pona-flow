import type { QueryObject } from "./types.js";

/** Default POINTS_TO attributive_label for STEP-to-STEP edges. Reusable; uniqueness is not required. */
export const DEFAULT_STEP_RELATIONSHIP_LABEL = "NEXT";

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

/**
 * Whether a create entity's attributive_label must be globally unique.
 *
 * STEP and SCHEMA *nodes* share one namespace, and so do new SCHEMA relationship types.
 * STEP-to-STEP POINTS_TO edges do not: they default to NEXT and any number of them may
 * share that label (or any other). INSTANCE labels name an existing SCHEMA.
 */
export function attributiveLabelRequiresUniqueness(
  clauseLabel: string,
  isNode: boolean
): boolean {
  if (clauseLabel === "SCHEMA") return true;
  if (clauseLabel === "STEP") return isNode;
  return false;
}

function collectFromQuery(
  query: QueryObject,
  clauseLabel: "STEP" | "SCHEMA",
  includeRelationships: boolean
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
        else if (includeRelationships) add(element.relationship);
      });
    });
  });
  return [...out];
}

/** Uniqueness-claimed labels: STEP/SCHEMA nodes and new SCHEMA relationship types. */
export function collectStepCreateAttributiveLabels(query: QueryObject): string[] {
  return collectFromQuery(query, "STEP", false);
}

export function collectSchemaCreateAttributiveLabels(query: QueryObject): string[] {
  return collectFromQuery(query, "SCHEMA", true);
}

export function collectCreateAttributiveLabels(query: QueryObject): string[] {
  return [
    ...collectStepCreateAttributiveLabels(query),
    ...collectSchemaCreateAttributiveLabels(query)
  ];
}

/**
 * Labels to register on ``spaces.labels`` so pickers can see them. Includes STEP
 * relationship labels (NEXT, …) that uniqueness does not claim.
 */
export function collectCreateCatalogLabels(query: QueryObject): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of [
    ...collectFromQuery(query, "STEP", true),
    ...collectFromQuery(query, "SCHEMA", true)
  ]) {
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
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
