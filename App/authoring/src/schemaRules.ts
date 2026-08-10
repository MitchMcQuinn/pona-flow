// Shared SCHEMA-create validation used both for inline field feedback
// (PropertyBinding) and Run gating (validation.ts).
import { regexValidator } from "@pona-flow/regex-validator";
import { extractExactParameterRef } from "./parameterRefs.js";
import { normalizeAttributiveLabel, normalizeSchemaPropertyKey } from "./normalizeField.js";
import type { SchemaPropertyConstraint } from "@pona-flow/connector";
import type { PropertyBinding, SchematicProperties, ValueType } from "./types.js";

const SCHEMA_VALUE_TYPES: ValueType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "UID",
  "radio",
  "checkbox"
];

/** radio/checkbox option + count configuration carried on a property/parameter. */
export interface ChoiceConfig {
  options?: string[];
  min_choices?: number;
  max_choices?: number;
}

/** Pull the radio/checkbox choice configuration off a schematic_properties-like object. */
export function choiceConfigOf(schema: {
  options?: string[];
  min_choices?: number;
  max_choices?: number;
}): ChoiceConfig {
  return {
    options: schema.options,
    min_choices: schema.min_choices,
    max_choices: schema.max_choices
  };
}

/** Normalize a stored checkbox value to its selected option strings. */
export function parseCheckboxSelection(raw: string): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  try {
    const parsed: unknown = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    /* fall through */
  }
  return [];
}

/** A checkbox value with no selections is treated as "no value" (like null/empty). */
export function isEmptyCheckboxRaw(valueType: ValueType, raw: string): boolean {
  return valueType === "checkbox" && parseCheckboxSelection(raw).length === 0;
}

/** Default INSTANCE key column when the SCHEMA author does not define is_key. */
export const DEFAULT_SCHEMA_KEY_PROPERTY_NAME = "id";

/** Reserved on SCHEMA create; implicit UID ``id`` is injected at compose time. */
export function isReservedSchemaPropertyKey(key: string): boolean {
  return (key ?? "").trim().toLowerCase() === DEFAULT_SCHEMA_KEY_PROPERTY_NAME;
}

export function validateSchemaPropertyKey(key: string): { valid: boolean; message: string } {
  const name = (key ?? "").trim();
  if (!name) return { valid: false, message: "required" };
  if (extractExactParameterRef(name)) return { valid: true, message: "" };
  if (isReservedSchemaPropertyKey(name)) {
    return {
      valid: false,
      message: `"${DEFAULT_SCHEMA_KEY_PROPERTY_NAME}" is reserved for the implicit INSTANCE key`
    };
  }
  if (normalizeSchemaPropertyKey(name) !== name || !/^[A-Z]/.test(name)) {
    return {
      valid: false,
      message: "must be an UPPER_SNAKE property name"
    };
  }
  return { valid: true, message: "" };
}

export interface SchemaPropertySchemaEntry {
  name: string;
  value_type: string;
  is_required: boolean;
  is_key: boolean;
  is_label: boolean;
  is_indexed: boolean;
  format?: string;
  default_value?: string;
  options?: string[];
  min_choices?: number;
  max_choices?: number;
}

/** Trim/dedupe configured radio/checkbox options, dropping empties. */
export function normalizeOptions(options: string[] | undefined): string[] {
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

function bindingToSchemaEntry(binding: PropertyBinding): SchemaPropertySchemaEntry | null {
  const sp = binding.schematic_properties;
  const name = normalizeSchemaPropertyKey((binding.key ?? "").trim());
  if (!sp || !name) return null;
  const value_type = toValueType(sp.value_type);
  const entry: SchemaPropertySchemaEntry = {
    name,
    value_type,
    is_required: Boolean(sp.is_required),
    is_key: false,
    is_label: Boolean(sp.is_label),
    is_indexed: Boolean(sp.is_indexed)
  };
  if (value_type === "string" && sp.format) entry.format = sp.format;
  if (value_type === "radio" || value_type === "checkbox") {
    entry.options = normalizeOptions(sp.options);
    if (value_type === "checkbox") {
      if (typeof sp.min_choices === "number") entry.min_choices = sp.min_choices;
      if (typeof sp.max_choices === "number") entry.max_choices = sp.max_choices;
    }
  }
  const raw = String(binding.value ?? "").trim();
  if (raw && !isSchemaNullRaw(raw) && !isEmptyCheckboxRaw(value_type, raw)) {
    entry.default_value = raw;
  }
  return entry;
}

/** Composer/API shape: `{ property_schema: { name, value_type, … } }`. */
export function effectiveSchemaSchemataPayload(
  bindings: PropertyBinding[]
): Array<{ property_schema: SchemaPropertySchemaEntry }> {
  const entries: SchemaPropertySchemaEntry[] = [];
  for (const binding of bindings) {
    const entry = bindingToSchemaEntry(binding);
    if (entry) entries.push(entry);
  }
  if (!entries.some((e) => e.is_key)) {
    entries.unshift({
      name: DEFAULT_SCHEMA_KEY_PROPERTY_NAME,
      value_type: "UID",
      is_required: true,
      is_key: true,
      is_label: false,
      is_indexed: false
    });
  }
  return entries.map((property_schema) => ({ property_schema }));
}

/** Flat constraints for INSTANCE adoption and schema definition API responses. */
export function effectiveSchemaConstraints(
  schemata: SchemaPropertyConstraint[]
): SchemaPropertyConstraint[] {
  const out = [...schemata];
  if (!out.some((c) => c.is_key)) {
    out.unshift({
      key: DEFAULT_SCHEMA_KEY_PROPERTY_NAME,
      value_type: "UID",
      is_required: true,
      is_key: true,
      is_label: false,
      is_indexed: false
    });
  }
  return out;
}

function toValueType(raw: string): ValueType {
  return (SCHEMA_VALUE_TYPES as string[]).includes(raw) ? (raw as ValueType) : "string";
}

// Build INSTANCE property bindings from a SCHEMA's flat constraints. Each binding
// carries the schematic_properties (for SQLite/index/common_label + validation) and
// the SCHEMA default_value as its starting value.
export function propertiesFromSchemata(schemata: SchemaPropertyConstraint[]): PropertyBinding[] {
  return effectiveSchemaConstraints(schemata).map((c) => {
    const value_type = toValueType(c.value_type);
    const schematic_properties: SchematicProperties = {
      value_type,
      format: c.format,
      is_required: Boolean(c.is_required),
      is_key: Boolean(c.is_key),
      is_label: Boolean(c.is_label),
      is_indexed: Boolean(c.is_indexed)
    };
    if (value_type === "radio" || value_type === "checkbox") {
      schematic_properties.options = normalizeOptions(c.options);
      if (value_type === "checkbox") {
        if (typeof c.min_choices === "number") schematic_properties.min_choices = c.min_choices;
        if (typeof c.max_choices === "number") schematic_properties.max_choices = c.max_choices;
      }
    }
    return { key: c.key, value: c.default_value ?? "", schematic_properties };
  });
}

// SCHEMA create: empty or "null" means "no default value" for any value_type.
export function isSchemaNullRaw(raw: string): boolean {
  const t = (raw ?? "").trim();
  return t === "" || t.toLowerCase() === "null";
}

// Parse a raw default value against the declared value_type. Throws on mismatch.
export function parseSchemaValue(valueType: ValueType, raw: string, choice?: ChoiceConfig): unknown {
  const t = (raw ?? "").trim();
  if (valueType === "boolean") {
    if (t === "true") return true;
    if (t === "false") return false;
    throw new Error("must be true or false");
  }
  if (valueType === "radio") {
    const options = normalizeOptions(choice?.options);
    if (!options.includes(t)) throw new Error("must be one of the configured options");
    return t;
  }
  if (valueType === "checkbox") {
    const options = normalizeOptions(choice?.options);
    const selected = parseCheckboxSelection(t);
    if (new Set(selected).size !== selected.length) throw new Error("duplicate selections");
    for (const s of selected) {
      if (!options.includes(s)) throw new Error(`"${s}" is not a configured option`);
    }
    const min = choice?.min_choices;
    const max = choice?.max_choices;
    if (typeof min === "number" && min > 0 && selected.length < min) {
      throw new Error(`select at least ${min}`);
    }
    if (typeof max === "number" && max > 0 && selected.length > max) {
      throw new Error(`select at most ${max}`);
    }
    return selected;
  }
  if (valueType === "integer") {
    if (!/^-?\d+$/.test(t)) throw new Error("integer required");
    return Number.parseInt(t, 10);
  }
  if (valueType === "number") {
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error("number required");
    return n;
  }
  if (valueType === "array") {
    const parsed = JSON.parse(t || "[]");
    if (!Array.isArray(parsed)) throw new Error("array required");
    return parsed;
  }
  return t; // string / UID
}

export interface DefaultValueCheck {
  valid: boolean;
  message: string;
}

// Validates a default value against value_type and, for strings, the regex format.
// A null/empty default is always valid (the property simply has no default).
export function validateSchemaDefaultValue(
  valueType: ValueType,
  format: string | undefined,
  raw: string,
  choice?: ChoiceConfig
): DefaultValueCheck {
  if (valueType === "UID") return { valid: true, message: "" };
  if (isSchemaNullRaw(raw) || isEmptyCheckboxRaw(valueType, raw)) {
    return { valid: true, message: "" };
  }
  try {
    parseSchemaValue(valueType, raw, choice);
  } catch (e) {
    return { valid: false, message: e instanceof Error ? e.message : `invalid ${valueType}` };
  }
  if (valueType === "string" && format && format !== "any") {
    const res = regexValidator.validate(format, raw);
    if (!res.valid && !res.skipped) {
      return { valid: false, message: res.error || `does not match "${format}"` };
    }
  }
  return { valid: true, message: "valid" };
}

// Parameter default with value_type "attributive label": empty means "no default";
// any provided value must satisfy attributive_label formatting (uppercase A–Z, digits, _).
export function validateAttributiveLabelValue(raw: string): DefaultValueCheck {
  const t = (raw ?? "").trim();
  if (isSchemaNullRaw(t)) return { valid: true, message: "" };
  if (normalizeAttributiveLabel(t) !== t || !/^[A-Z]/.test(t)) {
    return {
      valid: false,
      message: "must be an UPPER_SNAKE attributive label"
    };
  }
  return { valid: true, message: "valid" };
}

// INSTANCE create: like default-value validation, but a required property must
// have a non-null value. UID values are exempt — they are minted by the engine at
// run time, so the builder never holds (or requires) a concrete value.
export function validateInstanceValue(
  schema: SchematicProperties,
  raw: string
): DefaultValueCheck {
  if (schema.value_type === "UID") {
    return { valid: true, message: "" };
  }
  const empty = isSchemaNullRaw(raw) || isEmptyCheckboxRaw(schema.value_type, raw);
  if (schema.is_required && empty) {
    return { valid: false, message: "required" };
  }
  return validateSchemaDefaultValue(
    schema.value_type,
    schema.format,
    raw,
    choiceConfigOf(schema)
  );
}
