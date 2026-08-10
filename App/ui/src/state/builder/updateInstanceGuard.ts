// Schema guard for the update-INSTANCE flow. Update targets instances dynamically
// via MATCH {attributive_label} + WHERE filters + SET, so (unlike create) nothing
// otherwise pins the affected nodes/edges to their SCHEMA. These pure helpers
// validate SET/WHERE inputs against the bound schema and inspect the filter-matched
// instances for constraint violations. Side effects (fetch/compose/run) live in the
// useUpdateInstanceGuard hook so this module stays unit-testable.
import regexValidator from "../../services/regexValidator";
import type { SchemaDefinition } from "../../services/connector";
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { extractExactParameterRef } from "@pona-flow/authoring";
import {
  bindingForVariable,
  type ReadMatchPathBinding
} from "@pona-flow/authoring";
import {
  isSchemaNullRaw,
  propertiesFromSchemata,
  validateInstanceValue,
  validateSchemaDefaultValue
} from "@pona-flow/authoring";
import type {
  QueryObject,
  RunResult,
  SchematicProperties,
  SetItem,
  WhereItem
} from "./types";

/** Async-check registry keys. `uguard` blocks Run; `uguardInfo` is display-only. */
export const UPDATE_GUARD_CHECK_KEY = "uguard";
export const UPDATE_GUARD_INFO_KEY = "uguardInfo";

/** Cap on instances materialized by the guard read query (validation is a sample). */
export const GUARD_READ_LIMIT = 500;

export interface GuardIssue {
  scope: "set" | "where" | "instance";
  message: string;
}

/** Per-attributive_label constraint lookup keyed by property name. */
export type ConstraintsByLabel = Map<string, Map<string, SchematicProperties>>;

/** Build a `propertyKey -> SchematicProperties` map from a schema definition. */
export function schemaConstraintMap(
  def: SchemaDefinition | null | undefined
): Map<string, SchematicProperties> {
  const out = new Map<string, SchematicProperties>();
  if (!def) return out;
  for (const binding of propertiesFromSchemata(def.schemata ?? [])) {
    if (binding.schematic_properties) out.set(binding.key, binding.schematic_properties);
  }
  return out;
}

/** NUL-joined `attributiveLabel + propertyKey` key for covered-property lookups. */
function coveredKey(label: string, propertyKey: string): string {
  return `${label}\u0000${propertyKey}`;
}

/**
 * Properties this UPDATE's SET clause assigns a non-empty value to, keyed by the bound
 * `attributive_label`. A missing-but-required value the SET is about to fill must not
 * block the very update that resolves it; the value's own validity is checked separately
 * by {@link validateSetItems}. Parameter refs count as covered (their value arrives at run
 * time, and parameterized queries skip the live read anyway).
 */
export function setCoveredRequiredKeys(
  setItems: SetItem[],
  bindings: ReadMatchPathBinding[]
): Set<string> {
  const covered = new Set<string>();
  setItems.forEach((item) => {
    const pathVariable = (item.path_variable || "").trim();
    const propertyKey = (item.property_key || "").trim();
    if (!propertyKey) return;
    // A computed mode covers the key once it compiled to an expression; a literal
    // row needs a non-empty value (an empty assignment fixes nothing).
    const mode = item.value_mode ?? "literal";
    const complete =
      mode === "literal"
        ? String(item.value ?? "").trim().length > 0
        : item.expression.trim().length > 0;
    if (!complete) return;
    const binding = pathVariable ? bindingForVariable(bindings, pathVariable) : undefined;
    const label = binding?.attributive_label ?? (item.attributive_label || "").trim();
    if (!label || isAttributiveLabelParameter(label)) return;
    covered.add(coveredKey(label, propertyKey));
  });
  return covered;
}

/**
 * Validate each SET assignment value against its bound schema constraint
 * (value_type + format + required). Parameter values and parameterized schemas are
 * skipped (their defaults are validated through the parameters card). Incomplete
 * rows are left to validateQuery's empty-expression check.
 *
 * Computed modes replace the literal value check with a mode/property-type pairing:
 * "now" writes an ISO timestamp (string properties), "not_property" a boolean
 * (boolean target + boolean source property). Free-form "expression" rows skip
 * value validation entirely — Neo4j validates them at run time.
 */
export function validateSetItems(
  setItems: SetItem[],
  bindings: ReadMatchPathBinding[],
  constraintsByLabel: ConstraintsByLabel
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  setItems.forEach((item) => {
    const pathVariable = (item.path_variable || "").trim();
    const propertyKey = (item.property_key || "").trim();
    const rawValue = String(item.value ?? "");
    const mode = item.value_mode ?? "literal";
    if (!pathVariable || !propertyKey) return;
    if (mode === "literal" && extractExactParameterRef(rawValue.trim())) return;

    const binding = bindingForVariable(bindings, pathVariable);
    const label = binding?.attributive_label ?? (item.attributive_label || "").trim();
    if (!label || isAttributiveLabelParameter(label)) return;

    const constraints = constraintsByLabel.get(label);
    if (!constraints) return;
    const constraint = constraints.get(propertyKey);
    if (!constraint) {
      issues.push({
        scope: "set",
        message: `SET ${pathVariable}.${propertyKey}: property is not defined in schema "${label}".`
      });
      return;
    }
    // UID values (including the automatic instance id) are minted by the engine and
    // are the instance's identity — they may be filtered in WHERE but never reassigned.
    if (constraint.value_type === "UID") {
      issues.push({
        scope: "set",
        message: `SET ${pathVariable}.${propertyKey}: "${propertyKey}" is an engine-minted UID and cannot be reassigned.`
      });
      return;
    }
    if (mode === "now") {
      if (constraint.value_type !== "string") {
        issues.push({
          scope: "set",
          message: `SET ${pathVariable}.${propertyKey}: "now" writes a timestamp string, but the property is ${constraint.value_type}.`
        });
      }
      return;
    }
    if (mode === "not_property") {
      if (constraint.value_type !== "boolean") {
        issues.push({
          scope: "set",
          message: `SET ${pathVariable}.${propertyKey}: "negate property" writes a boolean, but the property is ${constraint.value_type}.`
        });
        return;
      }
      // Cross-check the negated source property when its schema is known.
      const sourceVariable = (item.source_variable || "").trim();
      const sourceProperty = (item.source_property || "").trim();
      const sourceBinding = sourceVariable
        ? bindingForVariable(bindings, sourceVariable)
        : undefined;
      const sourceLabel = sourceBinding?.attributive_label ?? "";
      if (sourceLabel && sourceProperty && !isAttributiveLabelParameter(sourceLabel)) {
        const sourceConstraint = constraintsByLabel.get(sourceLabel)?.get(sourceProperty);
        if (sourceConstraint && sourceConstraint.value_type !== "boolean") {
          issues.push({
            scope: "set",
            message: `SET ${pathVariable}.${propertyKey}: negated source ${sourceVariable}.${sourceProperty} is ${sourceConstraint.value_type}, not boolean.`
          });
        }
      }
      return;
    }
    if (mode === "expression") return;
    const check = validateInstanceValue(constraint, rawValue);
    if (!check.valid) {
      issues.push({ scope: "set", message: `SET ${pathVariable}.${propertyKey} value ${check.message}.` });
    }
  });
  return issues;
}

// WHERE filters compare against a value_type but may use partial-match operators
// (CONTAINS/STARTS WITH), so we validate the value_type only and skip string format
// to avoid false positives on legitimate fragments.
function collectFilterIssues(
  item: WhereItem | undefined,
  variable: string,
  constraints: Map<string, SchematicProperties> | undefined,
  issues: GuardIssue[]
): void {
  if (!item) return;
  if ("items" in item) {
    item.items.forEach((child) => collectFilterIssues(child, variable, constraints, issues));
    return;
  }
  if (!("property_key" in item)) return; // raw WhereCondition expression
  if (item.operator === "IS NULL" || item.operator === "IS NOT NULL") return;
  const value = String(item.value ?? "");
  if (!value.trim() || extractExactParameterRef(value.trim())) return;
  if (!constraints) return;
  const constraint = constraints.get((item.property_key || "").trim());
  if (!constraint) return; // property absent from schema (possible drift) — informational only
  const check = validateSchemaDefaultValue(constraint.value_type, undefined, value);
  if (!check.valid) {
    issues.push({ scope: "where", message: `WHERE ${variable}.${item.property_key} ${check.message}.` });
  }
}

/** Validate literal WHERE filter values across INSTANCE match patterns. */
export function validateWhereValues(
  query: QueryObject,
  constraintsByLabel: ConstraintsByLabel
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const step of pattern.path || []) {
        const entity = step.kind === "node" ? step.node : step.relationship;
        if (!entity) continue;
        const label = (entity.attributive_label || "").trim();
        const variable = (entity.variable || "").trim();
        if (!label || isAttributiveLabelParameter(label)) continue;
        collectFilterIssues(entity.where, variable, constraintsByLabel.get(label), issues);
      }
    }
  }
  return issues;
}

/**
 * Derive a read query from an update query's MATCH + WHERE that returns the matched
 * entities (capped), so the guard can materialize and inspect the affected instances.
 */
export function buildMatchReadQuery(
  query: QueryObject,
  bindings: ReadMatchPathBinding[]
): QueryObject {
  return {
    ...query,
    operation: "read",
    set: undefined,
    delete: undefined,
    order_by: undefined,
    skip: undefined,
    limit: { value: GUARD_READ_LIMIT },
    return: {
      // Variable-length aliases bind relationship *lists*, not entities — the graph
      // inspection below expects entity projections, so they are skipped (they can't
      // be SET targets anyway).
      items: bindings
        .filter((b) => !b.variableLength)
        .map((b) => ({
          expression: b.variable,
          path_variable: b.variable,
          attributive_label: b.attributive_label,
          entity_role: b.entityRole
        }))
    }
  };
}

// Graph-stored values already carry their Neo4j type, so we only flag drift that the
// schema cares about and that survives the round-trip: a missing required value, or a
// string that violates its declared format.
function checkMatchedEntity(
  properties: Record<string, unknown>,
  constraints: Map<string, SchematicProperties> | undefined,
  seen: Set<string>,
  issues: GuardIssue[],
  coveredRequiredKeys: Set<string>
): void {
  if (!constraints) return;
  const attributiveLabel = String(properties.attributive_label ?? "");
  const pushOnce = (sig: string, message: string) => {
    if (seen.has(sig)) return;
    seen.add(sig);
    issues.push({ scope: "instance", message });
  };
  for (const [key, schema] of constraints) {
    if (schema.value_type === "UID") continue;
    const raw = properties[key];
    const missing =
      raw === undefined || raw === null || (typeof raw === "string" && isSchemaNullRaw(raw));
    if (schema.is_required && missing) {
      // The SET clause in this same update is assigning this property, so the update
      // would resolve the violation — don't block it on pre-existing drift.
      if (coveredRequiredKeys.has(coveredKey(attributiveLabel, key))) continue;
      pushOnce(
        `req:${attributiveLabel}.${key}`,
        `Referenced ${attributiveLabel || "instance"}.${key} is required but missing on a matched instance.`
      );
      continue;
    }
    if (
      !missing &&
      schema.value_type === "string" &&
      schema.format &&
      schema.format !== "any" &&
      typeof raw === "string"
    ) {
      const res = regexValidator.validate(schema.format, raw);
      if (!res.valid && !res.skipped) {
        pushOnce(
          `fmt:${attributiveLabel}.${key}`,
          `Referenced ${attributiveLabel || "instance"}.${key} does not match "${schema.format}" on a matched instance.`
        );
      }
    }
  }
}

/** Inspect the materialized read result for blast radius + pre-existing drift. */
export function validateMatchedInstances(
  result: RunResult,
  constraintsByLabel: ConstraintsByLabel,
  coveredRequiredKeys: Set<string> = new Set()
): { count: number; issues: GuardIssue[] } {
  const issues: GuardIssue[] = [];
  const seen = new Set<string>();
  const nodes = result.graph?.nodes ?? [];
  const relationships = result.graph?.relationships ?? [];
  nodes.forEach((node) => {
    const props = node.properties ?? {};
    checkMatchedEntity(
      props,
      constraintsByLabel.get(String(props.attributive_label ?? "")),
      seen,
      issues,
      coveredRequiredKeys
    );
  });
  relationships.forEach((rel) => {
    const props = rel.properties ?? {};
    checkMatchedEntity(
      props,
      constraintsByLabel.get(String(props.attributive_label ?? "")),
      seen,
      issues,
      coveredRequiredKeys
    );
  });
  return { count: nodes.length + relationships.length, issues };
}

/** Join guard issues into a single (capped) human-readable check message. */
export function summarizeGuardIssues(issues: GuardIssue[]): string {
  const messages = issues.map((i) => i.message);
  const head = messages.slice(0, 4).join(" ");
  return messages.length > 4 ? `${head} (+${messages.length - 4} more)` : head;
}
