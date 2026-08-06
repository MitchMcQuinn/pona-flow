// Schema guard for the create-INSTANCE flow. A saved create-INSTANCE operation freezes the
// schema snapshot it was built against, so when the SCHEMA later changes (add/delete-only) the
// operation can drift even though eager reconciliation usually heals it. This is the lazy
// safety net: when such an operation is open in the builder we re-fetch the live schema and
// flag any residual drift (a binding for a deleted property, a value that no longer satisfies a
// live constraint, or a required live property the operation never sets). Side effects
// (fetch) live in the useCreateInstanceGuard hook so these helpers stay unit-testable.
import { isAttributiveLabelParameter } from "./normalizeField";
import { extractExactParameterRef } from "./parameterRefs";
import { validateInstanceValue } from "./schemaRules";
import { type ConstraintsByLabel } from "./updateInstanceGuard";
import type { PropertyBinding, QueryObject } from "./types";

/** Async-check registry key for the create-INSTANCE guard. Blocks Run when failing. */
export const CREATE_GUARD_CHECK_KEY = "cguard";

export interface CreateGuardIssue {
  message: string;
}

/** attributive_labels targeted by new create-INSTANCE nodes/relationships in this query. */
export function createInstanceLabels(query: QueryObject): string[] {
  const labels = new Set<string>();
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        if (el.kind === "node") {
          if (el.node.node_source !== "new" || el.node.alias_mode === "reference") continue;
          const al = (el.node.attributive_label || "").trim();
          if (al && !isAttributiveLabelParameter(al)) labels.add(al);
        } else {
          if (el.relationship.alias_mode === "reference") continue;
          const al = (el.relationship.attributive_label || "").trim();
          if (al && !isAttributiveLabelParameter(al)) labels.add(al);
        }
      }
    }
  }
  return [...labels];
}

function checkEntity(
  attributiveLabel: string,
  props: PropertyBinding[] | undefined,
  constraintsByLabel: ConstraintsByLabel,
  issues: CreateGuardIssue[]
): void {
  const al = (attributiveLabel || "").trim();
  if (!al || isAttributiveLabelParameter(al)) return;
  const constraints = constraintsByLabel.get(al);
  if (!constraints) return; // schema not resolvable (mid-edit / unknown): raise nothing.

  const present = new Set<string>();
  for (const prop of props || []) {
    const key = (prop.key || "").trim();
    if (!key) continue;
    present.add(key);
    const constraint = constraints.get(key);
    if (!constraint) {
      issues.push({ message: `${al}.${key}: property no longer exists in schema "${al}".` });
      continue;
    }
    const raw = String(prop.value ?? "");
    if (extractExactParameterRef(raw.trim())) continue; // resolved at run time
    const check = validateInstanceValue(constraint, raw);
    if (!check.valid) {
      issues.push({ message: `${al}.${key} value ${check.message}.` });
    }
  }

  for (const [key, constraint] of constraints) {
    if (constraint.value_type === "UID" || constraint.is_key) continue;
    if (constraint.is_required && !present.has(key)) {
      issues.push({
        message: `${al}.${key} is required by the schema but missing from this operation.`
      });
    }
  }
}

/** Validate every new create-INSTANCE entity against the live schema constraints. */
export function validateCreateInstances(
  query: QueryObject,
  constraintsByLabel: ConstraintsByLabel
): CreateGuardIssue[] {
  const issues: CreateGuardIssue[] = [];
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        if (el.kind === "node") {
          if (el.node.node_source !== "new" || el.node.alias_mode === "reference") continue;
          checkEntity(el.node.attributive_label ?? "", el.node.properties, constraintsByLabel, issues);
        } else {
          if (el.relationship.alias_mode === "reference") continue;
          checkEntity(
            el.relationship.attributive_label ?? "",
            el.relationship.properties,
            constraintsByLabel,
            issues
          );
        }
      }
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
