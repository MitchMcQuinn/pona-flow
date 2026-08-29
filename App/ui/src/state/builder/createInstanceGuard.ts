// Schema guard for the create-INSTANCE flow. A saved create-INSTANCE operation freezes the
// schema snapshot it was built against, so when the SCHEMA later changes (add/delete-only) the
// operation can drift even though eager reconciliation usually heals it. This is the lazy
// safety net: when such an operation is open in the builder we re-fetch the live schema and
// flag any residual drift (a binding for a deleted property, a value that no longer satisfies a
// live constraint, or a required live property the operation never sets). Side effects
// (fetch) live in the useCreateInstanceGuard hook so these helpers stay unit-testable.
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { extractExactParameterRef } from "@pona-flow/authoring";
import { validateInstanceValue } from "@pona-flow/authoring";
import { relSchemaKey } from "./createInstanceSync";
import { type ConstraintsByLabel } from "./updateInstanceGuard";
import type { PathElement, PropertyBinding, QueryObject } from "./types";

/** Async-check registry key for the create-INSTANCE guard. Blocks Run/save when failing. */
export const CREATE_GUARD_CHECK_KEY = "cguard";

export interface CreateGuardIssue {
  message: string;
}

function precedingNodeLabel(path: PathElement[], relIndex: number): string {
  const preceding = path[relIndex - 1];
  if (!preceding || preceding.kind !== "node") return "";
  return (preceding.node.attributive_label || "").trim();
}

/** attributive_labels of new create-INSTANCE nodes (need a SCHEMA definition fetch). */
export function createInstanceGuardNodeLabels(query: QueryObject): string[] {
  const labels = new Set<string>();
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        if (el.kind !== "node") continue;
        if (el.node.node_source !== "new" || el.node.alias_mode === "reference") continue;
        const al = (el.node.attributive_label || "").trim();
        if (al && !isAttributiveLabelParameter(al)) labels.add(al);
      }
    }
  }
  return [...labels];
}

/**
 * Preceding-node attributive_labels for create-INSTANCE relationships (need an outgoing-edge
 * fetch). Includes hops whose endpoints are existing instances — those still mint a new edge
 * whose property contract lives on the SCHEMA→SCHEMA POINTS_TO, not on a same-named SCHEMA node.
 */
export function createInstanceGuardPrecedingLabels(query: QueryObject): string[] {
  const labels = new Set<string>();
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      const path = pattern.path || [];
      path.forEach((el, i) => {
        if (el.kind !== "relationship") return;
        if (el.relationship.alias_mode === "reference") return;
        const relLabel = (el.relationship.attributive_label || "").trim();
        if (!relLabel || isAttributiveLabelParameter(relLabel)) return;
        const parent = precedingNodeLabel(path, i);
        if (parent && !isAttributiveLabelParameter(parent)) labels.add(parent);
      });
    }
  }
  return [...labels];
}

function checkEntity(
  attributiveLabel: string,
  props: PropertyBinding[] | undefined,
  constraintsByKey: ConstraintsByLabel,
  issues: CreateGuardIssue[],
  lookupKey: string
): void {
  const display = (attributiveLabel || "").trim();
  if (!display || isAttributiveLabelParameter(display)) return;
  const key = (lookupKey || "").trim();
  if (!key) return;
  const constraints = constraintsByKey.get(key);
  if (!constraints) return; // schema not resolvable (mid-edit / unknown): raise nothing.

  const present = new Set<string>();
  for (const prop of props || []) {
    const propKey = (prop.key || "").trim();
    if (!propKey) continue;
    present.add(propKey);
    const constraint = constraints.get(propKey);
    if (!constraint) {
      issues.push({ message: `${display}.${propKey}: property no longer exists in schema "${display}".` });
      continue;
    }
    const raw = String(prop.value ?? "");
    if (extractExactParameterRef(raw.trim())) continue; // resolved at run time
    const check = validateInstanceValue(constraint, raw);
    if (!check.valid) {
      issues.push({ message: `${display}.${propKey} value ${check.message}.` });
    }
  }

  for (const [propKey, constraint] of constraints) {
    if (constraint.value_type === "UID" || constraint.is_key) continue;
    if (constraint.is_required && !present.has(propKey)) {
      issues.push({
        message: `${display}.${propKey} is required by the schema but missing from this operation.`
      });
    }
  }
}

/**
 * Validate every new create-INSTANCE entity against the live schema constraints.
 *
 * - ``nodeConstraints`` is keyed by node attributive_label (SCHEMA definition).
 * - ``relConstraints`` is keyed by {@link relSchemaKey}(precedingLabel, relLabel), matching
 *   the hop picker's outgoing-edge ``rel_schemata`` rather than a same-named SCHEMA node.
 */
export function validateCreateInstances(
  query: QueryObject,
  nodeConstraints: ConstraintsByLabel,
  relConstraints: ConstraintsByLabel = new Map()
): CreateGuardIssue[] {
  const issues: CreateGuardIssue[] = [];
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      const path = pattern.path || [];
      path.forEach((el, i) => {
        if (el.kind === "node") {
          if (el.node.node_source !== "new" || el.node.alias_mode === "reference") return;
          const al = el.node.attributive_label ?? "";
          checkEntity(al, el.node.properties, nodeConstraints, issues, al);
          return;
        }
        if (el.relationship.alias_mode === "reference") return;
        const relLabel = el.relationship.attributive_label ?? "";
        checkEntity(
          relLabel,
          el.relationship.properties,
          relConstraints,
          issues,
          relSchemaKey(precedingNodeLabel(path, i), relLabel.trim())
        );
      });
    }
  }
  return issues;
}

/** Join guard issues into a single (capped) human-readable check message. */
export function summarizeCreateGuardIssues(issues: CreateGuardIssue[]): string {
  const messages = issues.map((i) => i.message);
  const head = messages.slice(0, 4).join(" ");
  return messages.length > 4 ? `${head} (+${messages.length - 4} more)` : head;
}
