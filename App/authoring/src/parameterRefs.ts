import { vectorKParameterName, vectorTextParameterName } from "@pona-flow/composer";
import { newSchematicProperties } from "./defaults.js";
import { PARAMETER_NAME_RE, STEP_BODY_PARAM_REF_RE } from "./stepBodyParams.js";
import type { Parameter, PropertyBinding, QueryObject, ValueType, WhereItem } from "./types.js";

const PARAM_REF_RE = STEP_BODY_PARAM_REF_RE;
const PARAM_REF_EXACT_RE = /^\$(?![0-9])(?!\{[0-9]+\})[A-Za-z_][A-Za-z0-9_]*$/;

/** Special value_type for parameters used in an attributive_label field. */
export const ATTRIBUTIVE_LABEL_VALUE_TYPE = "attributive label" as const;

/** Response format choices a Local LLM run may pick. */
const LOCAL_LLM_RESPONSE_FORMAT_OPTIONS = ["text", "json_schema"];

/**
 * Optional Local LLM overrides: a run may replace any saved config setting through
 * these parameters, blank meaning "keep the config's value". Mirrors the engine's
 * local_llms.OVERRIDE_KEYS / execution_compose._LOCAL_LLM_OVERRIDE_VALUE_TYPES.
 * `json_schema` is a string because parameters have no object value_type — the
 * engine parses the JSON text.
 */
const LOCAL_LLM_OVERRIDE_PARAMS: { name: string; value_type: ValueType; options?: string[] }[] = [
  { name: "system_prompt", value_type: "string" },
  {
    name: "response_format",
    value_type: "radio",
    options: LOCAL_LLM_RESPONSE_FORMAT_OPTIONS
  },
  { name: "json_schema", value_type: "string" },
  { name: "temperature", value_type: "number" },
  { name: "top_p", value_type: "number" },
  { name: "top_k", value_type: "integer" },
  { name: "min_p", value_type: "number" },
  { name: "repeat_penalty", value_type: "number" },
  { name: "num_ctx", value_type: "integer" },
  { name: "num_predict", value_type: "integer" },
  { name: "seed", value_type: "integer" },
  { name: "stop", value_type: "array" }
];

function addRefsFromText(raw: string, refs: Set<string>): void {
  PARAM_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAM_REF_RE.exec(raw)) !== null) {
    const name = (match[0] ?? "").slice(1);
    if (PARAMETER_NAME_RE.test(name)) refs.add(name);
  }
}

/** Returns parameter name when raw is exactly "$name", else null. */
export function extractExactParameterRef(raw: string): string | null {
  const t = String(raw ?? "").trim();
  if (!PARAM_REF_EXACT_RE.test(t)) return null;
  const name = t.slice(1);
  return PARAMETER_NAME_RE.test(name) ? name : null;
}

function addRefsFromWhereItem(item: WhereItem, refs: Set<string>): void {
  if ("items" in item) {
    item.items.forEach((child) => addRefsFromWhereItem(child, refs));
    return;
  }
  if ("expression" in item) {
    addRefsFromText(String(item.expression ?? ""), refs);
    return;
  }
  addRefsFromText(String(item.value ?? ""), refs);
}

/** Parameter names referenced from query input fields via $name tokens. */
export function collectReferencedParameterNames(query: QueryObject): string[] {
  const refs = new Set<string>();

  query.match.forEach((clause) => {
    // Create STEP: an existing node carries the *already-created* node's endpoint
    // template, but its config card is hidden and its parameters belong to that node
    // — not to this operation. Skip its sequencial_properties so they don't surface
    // as runtime parameters (which would block running). Other flows are untouched.
    const skipExistingStepNodeParams = query.operation === "create" && clause.label === "STEP";
    clause.patterns.forEach((pattern) => {
      pattern.path.forEach((el) => {
        if (el.kind === "node") {
          const alRef = extractExactParameterRef(String(el.node.attributive_label ?? ""));
          if (alRef) refs.add(alRef);
          // Existing-instance target whose id is supplied at run time ("$name").
          const idRef = extractExactParameterRef(String(el.node.id_binding?.value ?? ""));
          if (idRef) refs.add(idRef);
          el.node.properties.forEach((prop) => {
            const keyRef = extractExactParameterRef(String(prop.key ?? ""));
            if (keyRef) refs.add(keyRef);
            addRefsFromText(String(prop.value ?? ""), refs);
            if (prop.parameter && PARAMETER_NAME_RE.test(prop.parameter)) refs.add(prop.parameter);
          });
          if (!(skipExistingStepNodeParams && el.node.node_source === "existing")) {
            addRefsFromText(String(el.node.sequencial_properties?.endpoint ?? ""), refs);
            const body = el.node.sequencial_properties?.body;
            if (body !== undefined) addRefsFromText(JSON.stringify(body), refs);
            // Local LLM STEP: the engine always reads the sequence parameter `prompt`,
            // plus the optional parameters that override the saved config for a run.
            if (el.node.sequencial_properties?.step_type === "local_llm") {
              refs.add("prompt");
              LOCAL_LLM_OVERRIDE_PARAMS.forEach((p) => refs.add(p.name));
            }
          }
          if (el.node.where) addRefsFromWhereItem(el.node.where, refs);
        } else {
          const alRef = extractExactParameterRef(String(el.relationship.attributive_label ?? ""));
          if (alRef) refs.add(alRef);
          el.relationship.properties.forEach((prop) => {
            const keyRef = extractExactParameterRef(String(prop.key ?? ""));
            if (keyRef) refs.add(keyRef);
            addRefsFromText(String(prop.value ?? ""), refs);
            if (prop.parameter && PARAMETER_NAME_RE.test(prop.parameter)) refs.add(prop.parameter);
          });
          // A STEP transition guard names a value the *sequence* resolves at run time
          // (from an earlier step's response), not an input to this operation — so it
          // must not register as a parameter here. Mirrors buildStepTransitionQuery,
          // which wires the same edge headlessly and declares none.
          if (el.relationship.condition_type !== "parameter") {
            addRefsFromText(String(el.relationship.condition ?? ""), refs);
          }
          if (el.relationship.where) addRefsFromWhereItem(el.relationship.where, refs);
        }
      });
    });
  });

  if (query.where) addRefsFromWhereItem(query.where, refs);
  (query.set ?? []).forEach((item) => addRefsFromText(String(item.expression ?? ""), refs));
  (query.return?.items ?? []).forEach((item) => {
    addRefsFromText(String(item.expression ?? ""), refs);
    addRefsFromText(String(item.alias ?? ""), refs);
    // schema (path_variable) / property (property_key) parameters may be set before
    // the joined expression is complete; collect them directly so they register.
    addRefsFromText(String(item.path_variable ?? ""), refs);
    addRefsFromText(String(item.property_key ?? ""), refs);
    // Same for a boolean projection's compared-against value.
    addRefsFromText(String(item.comparison_value ?? ""), refs);
  });
  (query.unwind?.items ?? []).forEach((item) => {
    addRefsFromText(String(item.expression ?? ""), refs);
    addRefsFromText(String(item.path_variable ?? ""), refs);
    addRefsFromText(String(item.property_key ?? ""), refs);
  });
  (query.order_by ?? []).forEach((item) => addRefsFromText(String(item.expression ?? ""), refs));
  if (query.skip && "parameter" in query.skip && PARAMETER_NAME_RE.test(query.skip.parameter)) {
    refs.add(query.skip.parameter);
  }
  if (query.limit && "parameter" in query.limit && PARAMETER_NAME_RE.test(query.limit.parameter)) {
    refs.add(query.limit.parameter);
  }
  // Vector search: the search text and k may each be a $param a sequence supplies.
  [vectorTextParameterName(query), vectorKParameterName(query)].forEach((name) => {
    if (name && PARAMETER_NAME_RE.test(name)) refs.add(name);
  });

  return Array.from(refs).sort((a, b) => a.localeCompare(b));
}

export function hasReferencedParameters(query: QueryObject): boolean {
  return collectReferencedParameterNames(query).length > 0;
}

/** True when the query cannot be run directly from the builder (needs runtime params). */
export function queryUsesParameters(query: QueryObject): boolean {
  return query.parameters.length > 0 || hasReferencedParameters(query);
}

function defaultsForParameter(name: string): Parameter {
  return {
    name,
    data_type: "string",
    value: "",
    is_required: false,
    schematic_properties: newSchematicProperties()
  };
}

function normalizeParameterForUi(name: string, existing?: Parameter): Parameter {
  const base = existing ? { ...existing, name } : defaultsForParameter(name);
  return {
    ...base,
    name,
    schematic_properties: {
      ...newSchematicProperties(),
      ...(base.schematic_properties ?? {})
    }
  };
}

/**
 * Forced metadata and lock status for a referenced parameter, derived from where
 * it is used. Locked origins drive read-only fields in the parameters card.
 */
export interface ParameterOrigin {
  /** When set, value_type/format are forced and locked; when omitted they stay editable. */
  value_type?: ValueType;
  format?: string;
  is_required: boolean;
  locked: boolean;
  /** radio/checkbox choices inherited from the originating property (locked with the type). */
  options?: string[];
  min_choices?: number;
  max_choices?: number;
}

function isSchemaCreate(query: QueryObject): boolean {
  return query.operation === "create" && query.match[0]?.label === "SCHEMA";
}

function isInstanceCreate(query: QueryObject): boolean {
  return query.operation === "create" && query.match[0]?.label === "INSTANCE";
}

/**
 * Origin metadata inherited by a parameter bound to a SCHEMA-derived property: the
 * parameter conforms to the property's value_type/format/is_required and (for choice
 * types) its options/min/max. Returned locked so the parameters card mirrors the SCHEMA.
 */
function originFromSchematicProperties(
  sp: NonNullable<PropertyBinding["schematic_properties"]>,
  requiredFloor = false
): ParameterOrigin {
  const isChoice = sp.value_type === "radio" || sp.value_type === "checkbox";
  return {
    value_type: sp.value_type,
    format: sp.value_type === "string" ? sp.format : undefined,
    is_required: Boolean(sp.is_required) || requiredFloor,
    options: isChoice ? sp.options : undefined,
    min_choices: sp.value_type === "checkbox" ? sp.min_choices : undefined,
    max_choices: sp.value_type === "checkbox" ? sp.max_choices : undefined,
    locked: true
  };
}

/**
 * Classify each referenced parameter by its origin. Precedence (last wins):
 *   1. SCHEMA-create property default_value → inherits the property's metadata (locked).
 *   2. SCHEMA-create property name/key → always string / any / required (locked).
 *   3. attributive_label (any operation) → "attributive label" type, required (locked).
 *   4. RETURN schema/property/alias → required + locked; value_type stays editable.
 *   5. SKIP / LIMIT → integer, required (locked).
 *   6. Local LLM STEP → ``prompt`` string, required (locked), plus the optional
 *      setting overrides, each locked to its own value_type.
 */
export function collectParameterOriginMeta(query: QueryObject): Map<string, ParameterOrigin> {
  const out = new Map<string, ParameterOrigin>();
  const schemaCreate = isSchemaCreate(query);
  const instanceCreate = isInstanceCreate(query);

  query.match.forEach((clause) => {
    // Create STEP against an existing node: that node's Local LLM config belongs to the
    // already-saved STEP, not this operation's runtime parameters.
    const skipExistingStepNodeParams =
      query.operation === "create" && clause.label === "STEP";
    clause.patterns.forEach((pattern) => {
      pattern.path.forEach((el) => {
        if (schemaCreate) {
          const props = el.kind === "node" ? el.node.properties : el.relationship.properties;
          props.forEach((prop) => {
            const sp = prop.schematic_properties;
            const valueRef = extractExactParameterRef(String(prop.value ?? ""));
            if (valueRef && sp) {
              const prev = out.get(valueRef);
              out.set(valueRef, originFromSchematicProperties(sp, Boolean(prev?.is_required)));
            }
            const keyRef = extractExactParameterRef(String(prop.key ?? ""));
            if (keyRef) {
              out.set(keyRef, {
                value_type: "string",
                format: "any",
                is_required: true,
                locked: true
              });
            }
          });
        }

        // INSTANCE create: an exact $name typed into a SCHEMA-adopted property's value
        // is recognized as a run-time parameter that inherits and conforms to that
        // property's configuration (value_type/format/options/required).
        if (instanceCreate) {
          const props = el.kind === "node" ? el.node.properties : el.relationship.properties;
          props.forEach((prop) => {
            const sp = prop.schematic_properties;
            if (!sp) return;
            const paramRef = extractExactParameterRef(String(prop.value ?? ""));
            if (paramRef) out.set(paramRef, originFromSchematicProperties(sp));
          });

          // A parameterized existing-instance target: its id must be supplied at run
          // time, so the parameter is a required string (locked to that origin).
          if (el.kind === "node") {
            const idRef = extractExactParameterRef(String(el.node.id_binding?.value ?? ""));
            if (idRef) {
              out.set(idRef, {
                value_type: "string",
                format: "any",
                is_required: true,
                locked: true
              });
            }
          }
        }

        const attributiveLabel =
          el.kind === "node" ? el.node.attributive_label : el.relationship.attributive_label;
        const alRef = extractExactParameterRef(String(attributiveLabel ?? ""));
        if (alRef) {
          out.set(alRef, {
            value_type: ATTRIBUTIVE_LABEL_VALUE_TYPE,
            format: undefined,
            is_required: true,
            locked: true
          });
        }

        // Local LLM STEP: prompt is required (the engine always reads `prompt`); the
        // setting overrides are optional and fall back to the saved config when blank.
        if (
          el.kind === "node" &&
          el.node.sequencial_properties?.step_type === "local_llm" &&
          !(skipExistingStepNodeParams && el.node.node_source === "existing")
        ) {
          out.set("prompt", {
            value_type: "string",
            format: undefined,
            is_required: true,
            locked: true
          });
          LOCAL_LLM_OVERRIDE_PARAMS.forEach((p) => {
            out.set(p.name, {
              value_type: p.value_type,
              format: undefined,
              is_required: false,
              locked: true,
              options: p.options
            });
          });
        }
      });
    });
  });

  // RETURN projection fields: schema (path_variable), property (property_key), alias,
  // and a boolean projection's compared-against value. A parameter in any of these is
  // required + locked, but value_type stays editable — the identifiers are free-form,
  // and the comparison value's type follows whatever property it is measured against.
  (query.return?.items ?? []).forEach((item) => {
    [item.path_variable, item.property_key, item.alias, item.comparison_value].forEach((field) => {
      const ref = extractExactParameterRef(String(field ?? ""));
      if (ref) {
        out.set(ref, { format: undefined, is_required: true, locked: true });
      }
    });
  });

  // SKIP / LIMIT: a parameter here is an integer count — required, locked, integer.
  [query.skip, query.limit].forEach((ref) => {
    if (ref && "parameter" in ref && PARAMETER_NAME_RE.test(ref.parameter)) {
      out.set(ref.parameter, {
        value_type: "integer",
        format: undefined,
        is_required: true,
        locked: true
      });
    }
  });

  // Vector search: the search text is the string the engine embeds, k is a count.
  // Both are required (the search cannot run without them) and type-locked.
  const vectorText = vectorTextParameterName(query);
  if (vectorText && PARAMETER_NAME_RE.test(vectorText)) {
    out.set(vectorText, {
      value_type: "string",
      format: undefined,
      is_required: true,
      locked: true
    });
  }
  const vectorK = vectorKParameterName(query);
  if (vectorK && PARAMETER_NAME_RE.test(vectorK)) {
    out.set(vectorK, {
      value_type: "integer",
      format: undefined,
      is_required: true,
      locked: true
    });
  }

  return out;
}

/** Names of parameters whose card fields are locked (driven by their origin). */
export function collectLockedParameterNames(query: QueryObject): Set<string> {
  const locked = new Set<string>();
  collectParameterOriginMeta(query).forEach((origin, name) => {
    if (origin.locked) locked.add(name);
  });
  return locked;
}

/** Names whose value_type/format are pinned by their origin (subset of locked names). */
export function collectValueTypeLockedParameterNames(query: QueryObject): Set<string> {
  const locked = new Set<string>();
  collectParameterOriginMeta(query).forEach((origin, name) => {
    if (origin.locked && origin.value_type) locked.add(name);
  });
  return locked;
}

/**
 * Keep query.parameters aligned with discovered $param references, applying the
 * forced metadata for origin-locked parameters (property defaults/keys, attributive_label).
 *
 * Hand-declared parameters (`declared`) survive even while nothing references them: they
 * are inputs an author added deliberately — typically so a later step in a sequence can
 * read a value collected at the entry step — and a blank-named one has to live long enough
 * to be named.
 */
export function syncParametersFromReferences(query: QueryObject): QueryObject {
  const refs = collectReferencedParameterNames(query);
  const originMeta = collectParameterOriginMeta(query);

  const existingByName = new Map(query.parameters.map((p) => [String(p.name ?? "").trim(), p]));
  const referenced = new Set(refs);
  const next: Parameter[] = refs.map((name) => {
    const base = normalizeParameterForUi(name, existingByName.get(name));
    const meta = originMeta.get(name);
    if (!meta) return base;
    // When the origin forces a value_type, pin value_type/format/data_type; otherwise
    // keep the parameter's existing (user-editable) type and only force the required flag.
    const forcedType = meta.value_type;
    const baseSchematic = { ...newSchematicProperties(), ...base.schematic_properties };
    if (forcedType) {
      const legacyDataType =
        forcedType === "UID" ||
        forcedType === ATTRIBUTIVE_LABEL_VALUE_TYPE ||
        forcedType === "radio"
          ? "string"
          : forcedType === "checkbox"
            ? "array"
            : forcedType;
      const isChoice = forcedType === "radio" || forcedType === "checkbox";
      return {
        ...base,
        data_type: legacyDataType,
        is_required: meta.is_required,
        schematic_properties: {
          ...baseSchematic,
          value_type: forcedType,
          format: forcedType === "string" ? meta.format : undefined,
          is_required: meta.is_required,
          options: isChoice ? (meta.options ?? baseSchematic.options ?? []) : undefined,
          min_choices: forcedType === "checkbox" ? meta.min_choices : undefined,
          max_choices: forcedType === "checkbox" ? meta.max_choices : undefined
        }
      };
    }
    return {
      ...base,
      is_required: meta.is_required,
      schematic_properties: { ...baseSchematic, is_required: meta.is_required }
    };
  });

  query.parameters.forEach((param) => {
    if (!param.declared) return;
    const name = String(param.name ?? "").trim();
    if (name && referenced.has(name)) return;
    next.push(normalizeParameterForUi(name, param));
  });

  const unchanged =
    query.parameters.length === next.length &&
    query.parameters.every((p, i) => JSON.stringify(p) === JSON.stringify(next[i]));
  if (unchanged) return query;
  return { ...query, parameters: next };
}
