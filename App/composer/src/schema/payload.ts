/** SCHEMA schemata payload builders from property bindings. */

import { DEFAULT_SCHEMA_KEY_PROPERTY_NAME } from "../constants.js";
import type { Parameter, PropertyBinding, QueryObject, RelationshipPattern } from "../types.js";

/** Trim/dedupe configured radio/checkbox options, dropping empties. */
function normalizeChoiceOptions(options: string[] | undefined): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const opt of options) {
    const t = String(opt ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function propertySchemaFromBinding(binding: PropertyBinding | null | undefined) {
  const sp = binding && binding.schematic_properties;
  if (!sp || !binding.key) return null;
  const value_type =
    sp.value_type &&
    ["string", "number", "integer", "boolean", "array", "UID", "radio", "checkbox"].includes(
      sp.value_type
    )
      ? sp.value_type
      : "string";
  const property_schema: Record<string, unknown> = {
    name: binding.key,
    value_type,
    is_required: !!sp.is_required,
    is_key: false,
    is_label: !!sp.is_label,
    is_indexed: !!sp.is_indexed,
  };
  // Emitted only when set, so a SCHEMA that does not use vector search writes the payload
  // it always has.
  if (sp.is_embedded) {
    property_schema.is_embedded = true;
  }
  if (value_type === "string" && sp.format) {
    property_schema.format = sp.format;
  }
  if (value_type === "radio" || value_type === "checkbox") {
    property_schema.options = normalizeChoiceOptions(sp.options);
    if (value_type === "checkbox") {
      if (typeof sp.min_choices === "number") property_schema.min_choices = sp.min_choices;
      if (typeof sp.max_choices === "number") property_schema.max_choices = sp.max_choices;
    }
  }
  if (binding.value !== undefined && binding.value !== null && String(binding.value).trim() !== "") {
    property_schema.default_value = String(binding.value);
  }
  return { property_schema };
}

export function effectiveSchemataFromBindings(bindings: PropertyBinding[] | null | undefined) {
  const schemata: Array<{ property_schema: Record<string, unknown> }> = [];
  (bindings || []).forEach((binding) => {
    const entry = propertySchemaFromBinding(binding);
    if (entry) schemata.push(entry);
  });
  const hasKey = schemata.some((e) => e.property_schema && e.property_schema.is_key);
  if (!hasKey) {
    schemata.unshift({
      property_schema: {
        name: DEFAULT_SCHEMA_KEY_PROPERTY_NAME,
        value_type: "UID",
        is_required: true,
        is_key: true,
        is_label: false,
        is_indexed: false,
      },
    });
  }
  return schemata;
}

/**
 * SCHEMA node payload. `is_vectorized` is a sibling of `schemata` rather than a property
 * attribute (the same shape a relationship's `condition_type` uses) because it describes the
 * type, and it is written only when on so existing payloads are unaffected.
 */
export function schemaPayloadFromProperties(
  properties: PropertyBinding[] | null | undefined,
  flags?: { is_vectorized?: boolean } | null
): string {
  const schemata = effectiveSchemataFromBindings(properties);
  const payload: Record<string, unknown> = { schemata };
  if (flags && flags.is_vectorized) {
    payload.is_vectorized = true;
  }
  return JSON.stringify(payload);
}

export function schemaPayloadFromParametersLegacy(parameters: Parameter[] | null | undefined): string {
  const schemata = (parameters || [])
    .filter((p) => p && p.schematic_properties)
    .map((p) => {
      const sp = p.schematic_properties!;
      const isChoice = sp.value_type === "radio" || sp.value_type === "checkbox";
      return {
        property_schema: {
          name: p.name,
          value_type: sp.value_type,
          is_required: !!sp.is_required,
          is_key: !!sp.is_key,
          is_label: !!sp.is_label,
          is_indexed: !!sp.is_indexed,
          ...(sp.is_embedded ? { is_embedded: true } : {}),
          ...(sp.format ? { format: sp.format } : {}),
          ...(isChoice ? { options: normalizeChoiceOptions(sp.options) } : {}),
          ...(sp.value_type === "checkbox" && typeof sp.min_choices === "number"
            ? { min_choices: sp.min_choices }
            : {}),
          ...(sp.value_type === "checkbox" && typeof sp.max_choices === "number"
            ? { max_choices: sp.max_choices }
            : {}),
        },
      };
    });
  return JSON.stringify({ schemata });
}

export function schemaPayloadFromMatch(query: QueryObject): string {
  let properties: PropertyBinding[] = [];
  let flags: { is_vectorized?: boolean } | null = null;
  (query.match || []).forEach((clause) => {
    if (clause.label !== "SCHEMA") return;
    (clause.patterns || []).forEach((pattern) => {
      (pattern.path || []).forEach((step) => {
        if (step.kind === "node" && step.node && step.node.properties) {
          properties = step.node.properties;
          flags = { is_vectorized: !!step.node.is_vectorized };
        }
      });
    });
  });
  if (!properties.length) {
    return schemaPayloadFromParametersLegacy(query.parameters);
  }
  return schemaPayloadFromProperties(properties, flags);
}

export function stepRelPayload(rel: RelationshipPattern | null | undefined): string {
  if (!rel) return "{}";
  const payload: Record<string, unknown> = {};
  (rel.properties || []).forEach((p) => {
    if (!p || !p.key) return;
    if (["id", "attributive_label", "condition", "condition_type"].includes(p.key)) return;
    if (p.parameter) return;
    payload[p.key] = p.value;
  });
  // STEP relationship guard conditions live in the entities payload (SQLite) so they
  // can be edited and executed without touching Neo4j (see Engine execution.py).
  if (rel.condition_type && rel.condition_type !== "null") {
    payload.condition_type = String(rel.condition_type);
    if (rel.condition) payload.condition = String(rel.condition);
    // The expected boolean only gates `parameter` conditions; it lets a sibling
    // relationship branch on the same parameter resolving to the opposite value.
    if (rel.condition_type === "parameter" && typeof rel.condition_expected === "boolean") {
      payload.condition_expected = rel.condition_expected;
    }
  }
  return JSON.stringify(payload);
}

export function schemaRelPayload(rel: RelationshipPattern | null | undefined): string {
  if (!rel) return "{}";
  const payload: Record<string, unknown> = {};
  const schemata = effectiveSchemataFromBindings(rel.properties || []);
  if (schemata.length) {
    payload.schemata = schemata;
  }
  if (rel.is_vectorized) {
    payload.is_vectorized = true;
  }
  if (rel.condition_type && rel.condition_type !== "null") {
    payload.condition_type = String(rel.condition_type);
    if (rel.condition) payload.condition = String(rel.condition);
    if (rel.condition_type === "parameter" && typeof rel.condition_expected === "boolean") {
      payload.condition_expected = rel.condition_expected;
    }
  }
  return JSON.stringify(payload);
}
