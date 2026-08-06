/** Entity id resolution from bindings and schematic properties. */

import { exactParameterName } from "../literals.js";
import type {
  GraphNodeLabel,
  NodePattern,
  PropertyBinding,
  RelationshipPattern
} from "../types.js";

type EntityLike = NodePattern | RelationshipPattern | null | undefined;

export interface EntityIdOpts {
  clauseLabel?: GraphNodeLabel | string;
  operation?: string;
  entityKind?: "node" | "relationship";
}

/** The is_key property whose value_type is UID (an engine-minted graph id), if any. */
export function instanceUidKeyProperty(entity: EntityLike): PropertyBinding | null {
  if (!entity) return null;
  for (const p of entity.properties || []) {
    if (!p || !p.key) continue;
    const sp = p.schematic_properties;
    if (sp && sp.is_key) return sp.value_type === "UID" ? p : null;
  }
  return null;
}

/**
 * Run-time id parameter name for a new create-INSTANCE entity, or null when the
 * entity keeps an author-time literal id.
 *
 * UID keys (and builder-minted relationship id bindings) are never stable business
 * identifiers, so instead of baking the save-time value into the stored Cypher the
 * composer emits ``id: $id__<variable>``; the engine mints a fresh value once per
 * run. Existing targets, alias references, and concrete non-UID domain keys are
 * unaffected and stay literal.
 */
export function instanceCreateIdParamName(
  entity: EntityLike,
  opts: EntityIdOpts = {}
): string | null {
  if (!entity) return null;
  if (opts.clauseLabel !== "INSTANCE" || opts.operation !== "create") return null;
  if (entity.alias_mode === "reference" || entity.alias_ref) return null;
  const suffix = String(entity.variable || "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_");
  if (!suffix) return null;
  const isRelationship = opts.entityKind === "relationship";
  if (!isRelationship && entity.node_source === "existing") return null;
  if (instanceUidKeyProperty(entity)) return `id__${suffix}`;
  if (isRelationship) {
    // Created INSTANCE edges may carry a builder-minted id_binding instead of a UID
    // key property; those ids are minted at run time too. An exact $name binding is
    // already a caller-supplied parameter and keeps its legacy handling.
    const binding = entity.id_binding;
    if (binding && binding.key === "id" && !binding.parameter) {
      const value = String(binding.value ?? "").trim();
      if (value && !exactParameterName(value)) return `id__${suffix}`;
    }
  }
  return null;
}

export function instanceKeyIdLiteral(entity: EntityLike): string | null {
  if (!entity) return null;
  const props = entity.properties || [];
  for (let i = 0; i < props.length; i += 1) {
    const p = props[i];
    if (!p || !p.key || p.parameter) continue;
    const sp = p.schematic_properties;
    if (!sp || !sp.is_key) continue;
    const id = String(p.value ?? "").trim();
    return id || null;
  }
  return null;
}

function idLiteralFromEntity(
  entity: EntityLike,
  clauseLabel: GraphNodeLabel | string
): string | null {
  if (!entity) return null;
  if (clauseLabel === "INSTANCE") {
    const fromKey = instanceKeyIdLiteral(entity);
    if (fromKey) return fromKey;
  }
  const binding = entity.id_binding;
  if (binding && binding.key === "id" && binding.value !== undefined && !binding.parameter) {
    // An exact "$name" id is a run-time parameter, never a literal id.
    if (exactParameterName(binding.value)) return null;
    const id = String(binding.value).trim();
    return id || null;
  }
  const prop = (entity.properties || []).find((p) => p && p.key === "id" && !p.parameter);
  if (prop && prop.value !== undefined && prop.value !== null) {
    const id = String(prop.value).trim();
    return id || null;
  }
  return null;
}

/** Resolve a literal node id from is_key (INSTANCE), id_binding, or id property. */
export const nodeIdLiteral = idLiteralFromEntity;

/** Resolve a literal entity id (node or relationship) — same resolution rules as nodeIdLiteral. */
export const entityIdLiteral = idLiteralFromEntity;
