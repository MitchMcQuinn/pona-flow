import { validateOptionalAlias } from "./normalizeField.js";
import { validateStepBodyParameters } from "./stepBodyParams.js";
import { validateStepResponseParameters } from "./stepResponseParams.js";
import { ATTRIBUTIVE_LABEL_VALUE_TYPE, extractExactParameterRef } from "./parameterRefs.js";
import type {
  FieldCheck,
  MatchClause,
  NodePattern,
  Parameter,
  PropertyBinding,
  QueryObject
} from "./types.js";
import { instanceKeyRequiresValue } from "./instanceRules.js";
import { isEntityConfigUpdate, isLabelOnlyDelete } from "./matchMode.js";
import {
  choiceConfigOf,
  validateAttributiveLabelValue,
  validateInstanceValue,
  validateSchemaDefaultValue,
  validateSchemaPropertyKey
} from "./schemaRules.js";

// Pure structural validation, ported from the legacy validatePathStructure +
// create-gated checks. Returns human-readable warnings (empty array = valid).

// When there is only one pattern, warnings omit the pattern prefix entirely.
function patternWarningPrefix(patternIndex: number, patternCount: number): string {
  if (patternCount <= 1) return "";
  return `Pattern ${patternIndex + 1}: `;
}

function pushPatternWarning(
  warnings: string[],
  patternIndex: number,
  patternCount: number,
  message: string
): void {
  const prefix = patternWarningPrefix(patternIndex, patternCount);
  warnings.push(prefix ? `${prefix}${message}` : message);
}

// SCHEMA create: single-select caps is_label at one. Node schemas additionally require at least
// one is_label (``requireLabel``); relationship schemas are exempt (identified by their endpoints).
// Implicit UID ``id`` is_key is added at compose when the author omits a key.
function validateSchemaProperties(
  props: PropertyBinding[],
  parameters: Parameter[],
  patternIndex: number,
  patternCount: number,
  kind: string,
  warnings: string[],
  requireLabel: boolean
): void {
  const schema = props.filter((p) => p.schematic_properties && p.key.trim());
  const labelCount = schema.filter((p) => p.schematic_properties!.is_label).length;
  schema.forEach((p) => {
    const keyCheck = validateSchemaPropertyKey(p.key);
    if (!keyCheck.valid && keyCheck.message !== "required") {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        `${kind} property "${p.key}" ${keyCheck.message}.`
      );
    }
  });
  if (requireLabel && labelCount < 1) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      `${kind} must have one is_label property.`
    );
  } else if (labelCount > 1) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      `${kind} allows at most one is_label property (found ${labelCount}).`
    );
  }
  schema.forEach((p) => {
    const sp = p.schematic_properties!;
    const raw = String(p.value ?? "");
    const paramRef = extractExactParameterRef(raw);
    const refParam = paramRef
      ? parameters.find((param) => String(param.name ?? "").trim() === paramRef)
      : undefined;
    const check =
      refParam && refParam.schematic_properties
        ? validateSchemaDefaultValue(
            refParam.schematic_properties.value_type,
            refParam.schematic_properties.format,
            String(refParam.value ?? ""),
            choiceConfigOf(refParam.schematic_properties)
          )
        : validateSchemaDefaultValue(sp.value_type, sp.format, raw, choiceConfigOf(sp));
    if (!check.valid) {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        `property "${p.key}" default value ${check.message}.`
      );
    }
  });
}

// SCHEMA update: structural identity of existing (locked) properties is immutable, but their
// label/required/indexed flags and default_value may change; newly added properties must have a
// valid, unique key. The schema must keep at least one is_label property. A new required property
// does not need a default value — affected create/read/update INSTANCE operations are suspended
// until they are re-saved against the new pattern, rather than silently reconciled.
function validateSchemaUpdateProperties(
  props: PropertyBinding[],
  patternIndex: number,
  patternCount: number,
  warnings: string[]
): void {
  const seen = new Set<string>();
  let labelCount = 0;
  props.forEach((p) => {
    const sp = p.schematic_properties;
    if (!sp) return;
    if (sp.is_label) labelCount += 1;
    const key = (p.key || "").trim();
    if (key) {
      const lowered = key.toLowerCase();
      if (seen.has(lowered)) {
        pushPatternWarning(
          warnings,
          patternIndex,
          patternCount,
          `SCHEMA property "${key}" is duplicated.`
        );
      }
      seen.add(lowered);
    }
    // The key/name is immutable on a locked property, so only validate the key for new ones.
    if (!p.locked) {
      const keyCheck = validateSchemaPropertyKey(p.key);
      if (!keyCheck.valid) {
        pushPatternWarning(
          warnings,
          patternIndex,
          patternCount,
          `new SCHEMA property "${key || "(unnamed)"}" ${keyCheck.message}.`
        );
      }
    }
    // default_value is editable on locked properties now, so validate it for every property.
    const check = validateSchemaDefaultValue(sp.value_type, sp.format, String(p.value ?? ""), choiceConfigOf(sp));
    if (!check.valid) {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        `SCHEMA property "${key}" default value ${check.message}.`
      );
    }
  });
  if (labelCount < 1) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      `SCHEMA must have one is_label property.`
    );
  } else if (labelCount > 1) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      `SCHEMA allows at most one is_label property (found ${labelCount}).`
    );
  }
}

// INSTANCE create: every adopted property value must satisfy its SCHEMA constraint
// (required values present, value matching value_type/format). is_key uniqueness is
// validated asynchronously through the checks registry.
function validateInstanceProperties(
  props: PropertyBinding[],
  patternIndex: number,
  patternCount: number,
  kind: string,
  warnings: string[]
): void {
  props.forEach((p) => {
    if (!p.schematic_properties) return;
    // An exact $param value is filled at run time, so the literal value check (incl. the
    // required-value rule) is deferred to the supplied parameter's default instead.
    if (extractExactParameterRef(String(p.value ?? ""))) return;
    const check = validateInstanceValue(p.schematic_properties, String(p.value ?? ""));
    if (!check.valid) {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        `${kind} property "${p.key}" value ${check.message}.`
      );
    }
  });
}

function validateParameterDefaults(parameters: Parameter[], warnings: string[]): void {
  parameters.forEach((param) => {
    const name = String(param.name ?? "").trim();
    if (!name) return;
    const schema = param.schematic_properties;
    const valueType = schema?.value_type ?? "string";
    const format = schema?.format;
    const check =
      valueType === ATTRIBUTIVE_LABEL_VALUE_TYPE
        ? validateAttributiveLabelValue(String(param.value ?? ""))
        : validateSchemaDefaultValue(
            valueType,
            format,
            String(param.value ?? ""),
            schema ? choiceConfigOf(schema) : undefined
          );
    if (!check.valid) {
      warnings.push(`parameter "$${name}" default value ${check.message}.`);
    }
  });
}

export function formatStepBodyJson(body: unknown): string {
  if (body === undefined || body === null) return "{}";
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return "{}";
  }
}

/** Validate raw STEP custom-endpoint body text (must parse to a JSON object). */
export function validateStepBodyJson(raw: string): {
  valid: boolean;
  message: string;
  value?: Record<string, unknown>;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: true, message: "valid", value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { valid: true, message: "valid", value: parsed as Record<string, unknown> };
    }
    return { valid: false, message: "must be a JSON object" };
  } catch {
    return { valid: false, message: "invalid JSON" };
  }
}

// STEP create: new nodes require endpoint + body.
function validateStepSequencialProperties(
  node: NodePattern,
  parameters: Parameter[],
  patternIndex: number,
  patternCount: number,
  warnings: string[]
): void {
  // Meta-workflow: referencing an existing STEP only needs id + attributive_label for MATCH.
  if (node.node_source === "existing") return;

  // A custom-endpoint STEP is materialized as a concrete entity row whose $param tokens are
  // resolved at sequence runtime, so its identity must be literal (the graph MERGE has to
  // write a concrete attributive_label, not a runtime parameter).
  const stepQueryId = node.sequencial_properties?.query_id;
  const isOperationBacked = Boolean(stepQueryId && String(stepQueryId).trim());
  if (!isOperationBacked && extractExactParameterRef(String(node.attributive_label ?? ""))) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      "A custom-endpoint STEP node needs a literal attributive_label (not a $parameter)."
    );
  }

  const sp = node.sequencial_properties;
  if (!sp) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      "STEP node requires an endpoint."
    );
    pushPatternWarning(warnings, patternIndex, patternCount, "STEP node requires a body.");
    return;
  }
  // Code-execution STEP: validated on name + code (no endpoint/body). $param refs in
  // the code text reuse the body-parameter validation.
  if (sp.step_type === "code") {
    if (!(sp.resource_name ?? "").trim()) {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        "Code STEP node requires a name."
      );
    }
    if (!(sp.code ?? "").trim()) {
      pushPatternWarning(
        warnings,
        patternIndex,
        patternCount,
        "Code STEP node requires code."
      );
    } else {
      validateStepBodyParameters(String(sp.code ?? ""), parameters).forEach((message) => {
        pushPatternWarning(warnings, patternIndex, patternCount, message);
      });
    }
    validateStepResponseParameters(sp.response_parameters).forEach((message) => {
      pushPatternWarning(warnings, patternIndex, patternCount, message);
    });
    return;
  }
  if (!(sp.endpoint ?? "").trim()) {
    pushPatternWarning(warnings, patternIndex, patternCount, "STEP node requires an endpoint.");
  }
  const bodyCheck = validateStepBodyJson(formatStepBodyJson(sp.body));
  if (!bodyCheck.valid) {
    pushPatternWarning(
      warnings,
      patternIndex,
      patternCount,
      `STEP node body must be valid JSON (${bodyCheck.message}).`
    );
  } else if (sp.body === undefined) {
    pushPatternWarning(warnings, patternIndex, patternCount, "STEP node requires a body.");
  } else {
    const bodyRaw = formatStepBodyJson(sp.body);
    validateStepBodyParameters(bodyRaw, parameters).forEach((message) => {
      pushPatternWarning(warnings, patternIndex, patternCount, message);
    });
    validateStepResponseParameters(sp.response_parameters).forEach((message) => {
      pushPatternWarning(warnings, patternIndex, patternCount, message);
    });
  }
}

export function isStepCreateQuery(query: QueryObject): boolean {
  return query.operation === "create" && query.match[0]?.label === "STEP";
}

/**
 * Variables inside must-not-exist (absent) tails. Mirrors the composer's split rule:
 * on read SCHEMA/INSTANCE patterns, the first absent relationship with a preceding
 * named anchor node starts the negated tail; everything from there renders inside
 * NOT EXISTS { ... } and is never bound in the outer query. An earlier optional hop
 * claims the tail first (first flagged hop wins), so no absent split happens then.
 */
function collectAbsentTailVariables(query: QueryObject): Set<string> {
  const negated = new Set<string>();
  if (query.operation !== "read") return negated;
  query.match.forEach((clause) => {
    if (clause.label === "STEP") return;
    clause.patterns.forEach((pattern) => {
      let hasAnchor = false;
      let splitIndex = -1;
      for (let i = 0; i < pattern.path.length; i += 1) {
        const el = pattern.path[i];
        if (el.kind === "node") {
          if ((el.node.variable || "").trim()) hasAnchor = true;
          continue;
        }
        if (!hasAnchor) continue;
        if (el.relationship.absent === true) {
          splitIndex = i;
          break;
        }
        if (el.relationship.optional === true) break;
      }
      if (splitIndex < 0) return;
      for (let i = splitIndex; i < pattern.path.length; i += 1) {
        const el = pattern.path[i];
        const variable =
          el.kind === "node" ? el.node.variable : el.relationship.variable;
        if ((variable || "").trim()) negated.add(variable.trim());
      }
    });
  });
  return negated;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the expression references `variable` as a standalone identifier. */
function expressionReferencesVariable(expression: string, variable: string): boolean {
  if (!expression || !variable) return false;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_$.])${escapeRegExp(variable)}(?![A-Za-z0-9_])`
  );
  return re.test(expression);
}

// Must-not-exist tail variables only exist inside the NOT EXISTS subquery — the
// outer RETURN / ORDER BY cannot reference them.
function validateAbsentTailReferences(query: QueryObject, warnings: string[]): void {
  const negated = collectAbsentTailVariables(query);
  if (!negated.size) return;
  const referencedVariable = (expression: string, pathVariable?: string): string | null => {
    for (const variable of negated) {
      if (pathVariable?.trim() === variable) return variable;
      if (expressionReferencesVariable(expression, variable)) return variable;
    }
    return null;
  };
  (query.return?.items ?? []).forEach((item, index) => {
    const hit = referencedVariable(item.expression ?? "", item.path_variable);
    if (hit) {
      warnings.push(
        `RETURN projection ${index + 1}: "${hit}" is inside a must-not-exist pattern and cannot be returned.`
      );
    }
  });
  (query.order_by ?? []).forEach((item, index) => {
    const hit = referencedVariable(item.expression ?? "", item.path_variable);
    if (hit) {
      warnings.push(
        `ORDER BY ${index + 1}: "${hit}" is inside a must-not-exist pattern and cannot be ordered on.`
      );
    }
  });
}

/** Runtime catalog flag: STEP create only (SCHEMA/INSTANCE create always off). */
export function catalogRuntimeEnabled(query: QueryObject, runtimeEnabled: boolean): boolean {
  if (!isStepCreateQuery(query)) return false;
  return runtimeEnabled;
}

export function validateQuery(query: QueryObject, _runtimeEnabled: boolean): string[] {
  const warnings: string[] = [];
  const op = query.operation;

  if (!query.match.length) {
    warnings.push("At least one MATCH/CREATE clause is required.");
  }

  query.match.forEach((clause) => {
    validateClause(clause, op, query, warnings);
  });

  if (op === "read" && query.return && query.return.items.some((item) => !item.expression.trim())) {
    warnings.push("RETURN has an empty projection expression.");
  }

  (query.return?.items ?? []).forEach((item, index) => {
    const aliasError = validateOptionalAlias(item.alias);
    if (aliasError) {
      warnings.push(`RETURN projection ${index + 1}: ${aliasError}`);
    }
  });

  // SCHEMA/STEP updates edit entity config payloads (SQLite-only) and have no SET
  // clause; only INSTANCE updates run a graph MATCH…SET that requires a SET expression.
  if (
    op === "update" &&
    !isEntityConfigUpdate(op, query.match[0]?.label) &&
    (!query.set || query.set.every((s) => !s.expression.trim()))
  ) {
    warnings.push("UPDATE requires at least one SET expression.");
  }

  // Delete STEP/SCHEMA auto-targets every matched entity (DETACH DELETE composed in
  // normalizeForCompose), so it needs no manually selected target variable.
  if (
    op === "delete" &&
    !isLabelOnlyDelete(op, query.match[0]?.label) &&
    (!query.delete || !query.delete.targets.some((t) => t.trim()))
  ) {
    warnings.push("DELETE requires at least one target variable.");
  }

  validateAbsentTailReferences(query, warnings);

  validateParameterDefaults(query.parameters, warnings);

  return warnings;
}

function validateClause(
  clause: MatchClause,
  op: QueryObject["operation"],
  query: QueryObject,
  warnings: string[]
): void {
  const label = clause.label;
  const patternCount = clause.patterns.length;
  clause.patterns.forEach((pattern, pi) => {
    if (!pattern.path.length) {
      pushPatternWarning(warnings, pi, patternCount, "pattern is empty.");
      return;
    }
    if (pattern.path[0].kind !== "node") {
      pushPatternWarning(warnings, pi, patternCount, "a pattern must start with a node.");
    }
    if (pattern.path[pattern.path.length - 1].kind === "relationship") {
      pushPatternWarning(
        warnings,
        pi,
        patternCount,
        "a pattern must not end with a dangling relationship."
      );
    }

    pattern.path.forEach((element) => {
      if (element.kind === "node") {
        const node = element.node;
        if (!node.variable.trim()) {
          pushPatternWarning(warnings, pi, patternCount, "a node is missing its Cypher variable.");
        }
        const isReference = node.alias_mode === "reference";
        if (op === "create" && !isReference) {
          const hasAttributiveLabel = Boolean((node.attributive_label || "").trim());
          if (
            (label === "STEP" || label === "SCHEMA" || label === "INSTANCE") &&
            !hasAttributiveLabel
          ) {
            pushPatternWarning(
              warnings,
              pi,
              patternCount,
              `${label} node requires an attributive_label for create.`
            );
          }
          // STEP/INSTANCE: id and follow-on fields are filled in after the
          // attributive_label is chosen, so defer those warnings until then.
          const deferFollowOn = label === "STEP" || label === "INSTANCE";
          const followOn = !deferFollowOn || hasAttributiveLabel;
          if (label === "INSTANCE" && followOn && !node.node_source) {
            pushPatternWarning(
              warnings,
              pi,
              patternCount,
              "INSTANCE node requires a target (new or existing instance)."
            );
          }
          if (followOn && node.node_source === "new") {
            if (label === "INSTANCE") {
              // UID keys are minted at run time; only concrete (domain) keys still
              // need an author-supplied value.
              if (instanceKeyRequiresValue(node.properties)) {
                pushPatternWarning(
                  warnings,
                  pi,
                  patternCount,
                  "INSTANCE node requires a key property value for create."
                );
              }
              validateInstanceProperties(node.properties, pi, patternCount, "INSTANCE node", warnings);
            } else {
              const idVal = node.id_binding?.value;
              const hasId =
                idVal !== undefined && idVal !== null && String(idVal).trim() !== "";
              if (!hasId) {
                pushPatternWarning(
                  warnings,
                  pi,
                  patternCount,
                  `${label} node requires an id for create.`
                );
              }
            }
          }
          if (followOn && node.node_source === "existing" && label === "INSTANCE") {
            const idVal = node.id_binding?.value;
            const hasId =
              idVal !== undefined && idVal !== null && String(idVal).trim() !== "";
            if (!hasId) {
              pushPatternWarning(
                warnings,
                pi,
                patternCount,
                "INSTANCE node requires an existing instance id."
              );
            }
          }
          if (followOn && label === "STEP" && node.node_source !== "existing") {
            validateStepSequencialProperties(node, query.parameters, pi, patternCount, warnings);
          }
          if (
            label === "SCHEMA" &&
            node.node_source !== "existing" &&
            (node.attributive_label || "").trim()
          ) {
            validateSchemaProperties(
              node.properties,
              query.parameters,
              pi,
              patternCount,
              "SCHEMA node",
              warnings,
              true
            );
          }
        }
        if (op === "update" && label === "SCHEMA" && node.alias_mode !== "reference") {
          validateSchemaUpdateProperties(node.properties, pi, patternCount, warnings);
        }
      } else {
        const rel = element.relationship;
        if (!rel.variable.trim()) {
          pushPatternWarning(
            warnings,
            pi,
            patternCount,
            "a relationship is missing its Cypher variable."
          );
        }
        if (op === "create" && label === "SCHEMA" && rel.alias_mode !== "reference") {
          const hasLabel = (rel.attributive_label || "").trim();
          if (rel.node_source !== "existing" && !hasLabel) {
            pushPatternWarning(
              warnings,
              pi,
              patternCount,
              "SCHEMA relationship requires an attributive_label for create."
            );
          }
          if (rel.node_source !== "existing" && hasLabel) {
            validateSchemaProperties(
              rel.properties,
              query.parameters,
              pi,
              patternCount,
              "SCHEMA relationship",
              warnings,
              false
            );
          }
        }
        if (op === "create" && label === "INSTANCE" && rel.alias_mode !== "reference") {
          const hasLabel = (rel.attributive_label || "").trim();
          if (!hasLabel) {
            pushPatternWarning(
              warnings,
              pi,
              patternCount,
              "INSTANCE relationship requires an attributive_label for create."
            );
          } else {
            validateInstanceProperties(
              rel.properties,
              pi,
              patternCount,
              "INSTANCE relationship",
              warnings
            );
          }
        }
      }
    });
  });
}

// Async-check gating: every registered check must be resolved and not duplicate.
export function isActiveCheckKey(key: string, query: QueryObject): boolean {
  // uguardInfo: display-only blast-radius note; never participates in Run gating.
  if (key === "uguardInfo") return false;
  // uguard: update-INSTANCE schema guard. Active only for that flow so a stale check
  // left behind after switching operations cannot block create/read/delete.
  if (key === "uguard") {
    return query.operation === "update" && query.match[0]?.label === "INSTANCE";
  }
  // cguard: create-INSTANCE schema drift guard. Active only for that flow so a stale check
  // left behind after switching operations cannot block other operations.
  if (key === "cguard") {
    return query.operation === "create" && query.match[0]?.label === "INSTANCE";
  }
  // ikey: instance is_key uniqueness, addressed clause:pattern:path:property.
  const ikey = /^ikey:(\d+):(\d+):(\d+):(\d+)$/.exec(key);
  if (ikey) {
    const el = query.match[Number(ikey[1])]?.patterns[Number(ikey[2])]?.path[Number(ikey[3])];
    return Boolean(el);
  }
  const stepBody = /^stepBody:(\d+):(\d+):(\d+)$/.exec(key);
  if (stepBody) {
    const el = query.match[Number(stepBody[1])]?.patterns[Number(stepBody[2])]?.path[Number(stepBody[3])];
    if (el?.kind !== "node") return false;
    // Existing STEP picks are read-only; body/parameter checks apply only to new nodes.
    return el.node.node_source !== "existing";
  }
  // alparam:<name> — attributive_label parameter default uniqueness. Active only
  // while a matching "attributive label" parameter still exists in the query.
  const alParam = /^alparam:(.+)$/.exec(key);
  if (alParam) {
    const name = alParam[1];
    return query.parameters.some(
      (p) =>
        String(p.name ?? "").trim() === name &&
        p.schematic_properties?.value_type === ATTRIBUTIVE_LABEL_VALUE_TYPE
    );
  }
  const m = /^(?:al|gid):(\d+):(\d+):(\d+)$/.exec(key);
  if (!m) return true;
  const clauseIndex = Number(m[1]);
  const patternIndex = Number(m[2]);
  const pathIndex = Number(m[3]);
  return Boolean(query.match[clauseIndex]?.patterns[patternIndex]?.path[pathIndex]);
}

// Async-check gating: every active check must be resolved and not duplicate.
export function checksAllClear(
  checks: Record<string, FieldCheck>,
  query: QueryObject
): boolean {
  return Object.entries(checks)
    .filter(([key]) => isActiveCheckKey(key, query))
    .every(([, check]) => check.status === "ok" || check.status === "idle");
}
