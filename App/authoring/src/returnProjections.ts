import { hopTailVariables } from "@pona-flow/composer";
import { isAttributiveLabelParameter } from "./normalizeField.js";
import type { QueryObject, ReturnItem } from "./types.js";

export interface ReadMatchPathBinding {
  variable: string;
  attributive_label: string;
  entityRole: "node" | "relationship";
  /**
   * The alias binds a variable-length hop (*min..max) and therefore a *list* of
   * relationships — alias.property references (SET targets, sources, WHERE
   * predicates) are invalid Cypher, so pickers must not offer it.
   */
  variableLength?: boolean;
  /**
   * The alias is bound by an OPTIONAL MATCH segment, so it is null on rows where the
   * hop did not match. Valid to reference; pickers flag it so the author knows the
   * assignment or deletion is a no-op for those rows.
   */
  nullable?: boolean;
  /**
   * The alias lives inside a must-not-exist (NOT EXISTS) tail and is never bound in
   * the outer query — referencing it is invalid Cypher, so pickers must not offer it.
   */
  unbound?: boolean;
}

/** Hop-tail flags for a variable, spread into the binding it belongs to. */
function hopTailFlags(
  variable: string,
  tails: { optional: Set<string>; absent: Set<string> }
): Pick<ReadMatchPathBinding, "nullable" | "unbound"> {
  return {
    ...(tails.optional.has(variable) ? { nullable: true as const } : {}),
    ...(tails.absent.has(variable) ? { unbound: true as const } : {})
  };
}

/** Path variables with attributive_label from INSTANCE match patterns (read RETURN pickers). */
export function collectReadMatchPathBindings(query: QueryObject): ReadMatchPathBinding[] {
  const out: ReadMatchPathBinding[] = [];
  const seen = new Set<string>();
  const tails = hopTailVariables(query);
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const step of pattern.path || []) {
        if (step.kind === "node" && step.node) {
          const variable = (step.node.variable || "").trim();
          const attributive_label = (step.node.attributive_label || "").trim();
          if (!variable || !attributive_label) continue;
          const key = `node:${variable}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            variable,
            attributive_label,
            entityRole: "node",
            ...hopTailFlags(variable, tails)
          });
        } else if (step.kind === "relationship" && step.relationship) {
          const variable = (step.relationship.variable || "").trim();
          const attributive_label = (step.relationship.attributive_label || "").trim();
          if (!variable || !attributive_label) continue;
          const key = `rel:${variable}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rel = step.relationship;
          const variableLength = Boolean(
            rel.length && (rel.length.min !== undefined || rel.length.max !== undefined)
          );
          out.push({
            variable,
            attributive_label,
            entityRole: "relationship",
            ...(variableLength ? { variableLength } : {}),
            ...hopTailFlags(variable, tails)
          });
        }
      }
    }
  }
  return out;
}

/**
 * Path variables for DELETE target pickers. Unlike the read RETURN bindings this
 * spans every graph label (STEP/SCHEMA/INSTANCE) so the delete card can offer a
 * match-bound dropdown in those flows too; entries are kept even when an
 * attributive_label is missing so a freshly added node is still selectable.
 *
 * Must-not-exist tail variables are omitted entirely: they are bound only inside the
 * NOT EXISTS subquery, so a DELETE against one is invalid Cypher. Dropping them here
 * also lets the delete card's stale-target effect clear a selection when its hop is
 * switched to "must not exist".
 */
export function collectDeleteTargetBindings(query: QueryObject): ReadMatchPathBinding[] {
  const out: ReadMatchPathBinding[] = [];
  const seen = new Set<string>();
  const tails = hopTailVariables(query);
  for (const clause of query.match || []) {
    for (const pattern of clause.patterns || []) {
      for (const step of pattern.path || []) {
        if (step.kind === "node" && step.node) {
          const variable = (step.node.variable || "").trim();
          if (!variable || tails.absent.has(variable)) continue;
          const key = `node:${variable}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            variable,
            attributive_label: (step.node.attributive_label || "").trim(),
            entityRole: "node",
            ...hopTailFlags(variable, tails)
          });
        } else if (step.kind === "relationship" && step.relationship) {
          const variable = (step.relationship.variable || "").trim();
          if (!variable || tails.absent.has(variable)) continue;
          const key = `rel:${variable}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            variable,
            attributive_label: (step.relationship.attributive_label || "").trim(),
            entityRole: "relationship",
            ...hopTailFlags(variable, tails)
          });
        }
      }
    }
  }
  return out;
}

/**
 * The variable a target-less DELETE can be auto-filled with, when unambiguous.
 *
 * A delete whose MATCH binds exactly one entity (e.g. one INSTANCE node filtered by
 * WHERE id = $param) can only ever target that entity, so requiring a manual pick
 * just blocks creation. Multi-entity matches return null and keep the explicit
 * picker (deleting path endpoints/relationships must stay a deliberate choice).
 */
export function soleDeleteTargetVariable(query: QueryObject): string | null {
  if (query.operation !== "delete") return null;
  const targets = query.delete?.targets ?? [];
  if (targets.some((t) => (t || "").trim())) return null;
  const bindings = collectDeleteTargetBindings(query);
  return bindings.length === 1 ? bindings[0].variable : null;
}

/**
 * Display labels for binding pickers, keyed by variable. When the same
 * attributive_label is bound more than once in the MATCH (e.g. an
 * ACTION → NEXT → ACTION sequence), the bare label is ambiguous in dropdowns,
 * so duplicates are numbered in path order ("ACTION 1", "ACTION 2"). Unique
 * labels stay unnumbered; bindings without a label fall back to their variable.
 *
 * Pass the *unfiltered* binding list so numbering stays consistent across
 * pickers that filter differently (e.g. variable-length exclusions).
 *
 * Optional-hop bindings are suffixed "(optional)" — they are null wherever the hop
 * misses, which changes what a projection or an assignment against them means.
 */
export function bindingDisplayLabels(bindings: ReadMatchPathBinding[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const b of bindings) {
    if (!b.attributive_label) continue;
    counts.set(b.attributive_label, (counts.get(b.attributive_label) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  const out = new Map<string, string>();
  for (const b of bindings) {
    const label = b.attributive_label;
    let display: string;
    if (!label) {
      display = b.variable;
    } else if ((counts.get(label) ?? 0) > 1) {
      const n = (ordinals.get(label) ?? 0) + 1;
      ordinals.set(label, n);
      display = `${label} ${n}`;
    } else {
      display = label;
    }
    out.set(b.variable, b.nullable ? `${display} (optional)` : display);
  }
  return out;
}

/** True when a schema/property field value is a parameter reference ($name). */
export function isReturnFieldParameter(value: string | undefined): boolean {
  return isAttributiveLabelParameter(String(value ?? ""));
}

export function readReturnExpression(pathVariable: string, propertyKey: string): string {
  const v = pathVariable.trim();
  const k = propertyKey.trim();
  if (!v || !k) return "";
  return `${v}.${k}`;
}

export function bindingForVariable(
  bindings: ReadMatchPathBinding[],
  variable: string
): ReadMatchPathBinding | undefined {
  const want = variable.trim();
  return bindings.find((b) => b.variable === want);
}

/** Parse `alias.property` when alias matches a path binding. */
export function parseReadReturnExpression(
  expression: string,
  bindings: ReadMatchPathBinding[]
): { path_variable: string; property_key: string } | null {
  const trimmed = expression.trim();
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/);
  if (!match) return null;
  const path_variable = match[1];
  const property_key = match[2];
  if (!bindingForVariable(bindings, path_variable)) return null;
  return { path_variable, property_key };
}

export function resolvedReadReturnFields(
  item: ReturnItem,
  bindings: ReadMatchPathBinding[]
): { path_variable: string; property_key: string; attributive_label: string; entityRole: "node" | "relationship" } {
  let path_variable = (item.path_variable || "").trim();
  let property_key = (item.property_key || "").trim();
  if (!path_variable || !property_key) {
    const parsed = parseReadReturnExpression(item.expression, bindings);
    if (parsed) {
      path_variable = parsed.path_variable;
      property_key = parsed.property_key;
    }
  }
  const binding = bindingForVariable(bindings, path_variable);
  return {
    path_variable,
    property_key,
    attributive_label: binding?.attributive_label ?? (item.attributive_label || "").trim(),
    entityRole: binding?.entityRole ?? item.entity_role ?? "node"
  };
}

export function readReturnItemPatch(
  bindings: ReadMatchPathBinding[],
  pathVariable: string,
  propertyKey: string
): Partial<ReturnItem> {
  const binding = bindingForVariable(bindings, pathVariable);
  const expression = readReturnExpression(pathVariable, propertyKey);
  return {
    path_variable: pathVariable.trim() || undefined,
    property_key: propertyKey.trim() || undefined,
    attributive_label: binding?.attributive_label,
    entity_role: binding?.entityRole,
    expression
  };
}
