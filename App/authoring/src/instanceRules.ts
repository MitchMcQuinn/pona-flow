import { isSchemaNullRaw } from "./schemaRules.js";
import { attributiveLabelToDefaultAlias } from "./matchAlias.js";
import type { GraphIdBinding, PropertyBinding, QueryObject } from "./types.js";

export const INSTANCE_ALIAS_DEFAULT_PLACEHOLDER = "Defaults to schema label";

export function instanceKeyProperty(
  properties: PropertyBinding[]
): PropertyBinding | undefined {
  return properties.find((p) => p.schematic_properties?.is_key);
}

/** True when the entity's key is a UID: minted by the engine at run time, never authored. */
export function instanceKeyIsUid(properties: PropertyBinding[]): boolean {
  return instanceKeyProperty(properties)?.schematic_properties?.value_type === "UID";
}

/** Graph entity id for INSTANCE create: value of the SCHEMA is_key property. */
export function instanceKeyValue(properties: PropertyBinding[]): string {
  const key = instanceKeyProperty(properties);
  if (!key) return "";
  const raw = String(key.value ?? "").trim();
  return isSchemaNullRaw(raw) ? "" : raw;
}

/**
 * Whether the entity still needs an author-supplied key value before it can be
 * created. UID keys are exempt — the composer emits `id: $id__<alias>` and the
 * engine mints a fresh value per run.
 */
export function instanceKeyRequiresValue(properties: PropertyBinding[]): boolean {
  const key = instanceKeyProperty(properties);
  if (!key) return true;
  if (key.schematic_properties?.value_type === "UID") return false;
  return !instanceKeyValue(properties);
}

/** Every node/relationship variable declared in the query (for alias dedupe). */
export function collectQueryVariables(query: QueryObject): string[] {
  const variables: string[] = [];
  for (const clause of query.match ?? []) {
    for (const pattern of clause.patterns ?? []) {
      for (const el of pattern.path ?? []) {
        const variable =
          el.kind === "node" ? el.node.variable : el.relationship.variable;
        const trimmed = (variable ?? "").trim();
        if (trimmed) variables.push(trimmed);
      }
    }
  }
  return variables;
}

/**
 * Cypher-safe default alias for a create-INSTANCE entity, derived from its schema
 * attributive_label and deduplicated against the variables already used in the query
 * (two PILLAR nodes must not share one variable — that would merge them into a
 * single entity and collide their `id__<alias>` run-time parameters).
 */
export function deriveInstanceAlias(
  attributiveLabel: string,
  takenVariables: Iterable<string>
): string {
  const base = attributiveLabelToDefaultAlias(attributiveLabel || "") || "n0";
  const taken = new Set(takenVariables);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * id_binding / variable patch for a create-INSTANCE entity.
 *
 * UID keys have no author-time id: id_binding stays unset and the default variable
 * derives from the schema attributive_label (the variable also names the entity's
 * `id__<variable>` run-time parameter). Concrete non-UID domain keys keep the legacy
 * behavior: the key value is the graph id and the default variable.
 */
export function instanceEntityIdPatch(
  entity: { alias_locked?: boolean; variable?: string },
  properties: PropertyBinding[],
  opts: { attributiveLabel: string; takenVariables: Iterable<string> }
): { id_binding?: GraphIdBinding; variable: string } {
  const keyProp = instanceKeyProperty(properties);
  if (!keyProp || keyProp.schematic_properties?.value_type === "UID") {
    return {
      id_binding: undefined,
      variable: entity.alias_locked
        ? (entity.variable ?? "").trim()
        : deriveInstanceAlias(opts.attributiveLabel, opts.takenVariables)
    };
  }
  const keyVal = instanceKeyValue(properties);
  return {
    id_binding: keyVal ? { key: "id", value: keyVal } : undefined,
    variable: entity.alias_locked ? (entity.variable ?? "").trim() : keyVal
  };
}
