import { ALIAS_NAME_PATTERN, normalizeAlias, normalizeAttributiveLabel } from "./normalizeField.js";
import type { PathElement, QueryObject } from "./types.js";

export const MATCH_ALIAS_DEFAULT_PLACEHOLDER = "Defaults to attributive label";

/** True when the user picked an existing alias from the dropdown (not a new define). */
export function isAliasReference(entity: { alias_mode?: string } | null | undefined): boolean {
  return entity?.alias_mode === "reference";
}

/** Alias is fixed (reference or explicitly locked); hide the alias picker. */
export function isAliasSet(entity: { alias_locked?: boolean; alias_mode?: string } | null | undefined): boolean {
  return isAliasReference(entity) || entity?.alias_locked === true;
}

/** Unlocked match alias still equals the auto-derived name from attributive_label. */
export function matchAliasIsAttributiveDefault(
  variable: string,
  defaultAlias: string,
  locked: boolean,
  hasAttributiveLabel: boolean
): boolean {
  if (locked || !hasAttributiveLabel || !defaultAlias.trim()) return false;
  return (variable.trim() || defaultAlias.trim()) === defaultAlias.trim();
}

/** Match card title: show alias only after attributive_label is chosen. */
export function matchCardTitleAlias(
  variable: string | undefined,
  hasAttributiveLabel: boolean
): string {
  if (!hasAttributiveLabel) return "";
  return (variable ?? "").trim();
}

/** Cypher-safe alias derived from an attributive_label (read/update/delete match). */
export function attributiveLabelToDefaultAlias(attributiveLabel: string): string {
  const direct = normalizeAlias(attributiveLabel);
  if (direct && ALIAS_NAME_PATTERN.test(direct)) return direct;
  const scrub = normalizeAttributiveLabel(attributiveLabel);
  const prefixed = normalizeAlias(`n${scrub}`);
  if (prefixed && ALIAS_NAME_PATTERN.test(prefixed)) return prefixed;
  return scrub ? `n${scrub}` : "n0";
}

export function defaultMatchNodeAlias(attributiveLabel: string): string {
  return attributiveLabelToDefaultAlias(attributiveLabel);
}

/** Relationship variables already used anywhere in the query (optionally excluding one). */
export function collectRelationshipVariables(
  query: QueryObject,
  exclude?: { clauseIndex: number; patternIndex: number; pathIndex: number }
): Set<string> {
  const vars = new Set<string>();
  query.match.forEach((clause, ci) => {
    clause.patterns.forEach((pattern, pi) => {
      pattern.path.forEach((el, xi) => {
        if (el.kind !== "relationship") return;
        if (
          exclude &&
          ci === exclude.clauseIndex &&
          pi === exclude.patternIndex &&
          xi === exclude.pathIndex
        ) {
          return;
        }
        const variable = (el.relationship.variable ?? "").trim();
        if (variable) vars.add(variable);
      });
    });
  });
  return vars;
}

/**
 * Default relationship variable (NEXT, NEXT_2, NEXT_3, …) derived from the
 * attributive_label and made unique across the WHOLE query — not just the current
 * path. Cypher rejects reusing a relationship variable across patterns ("Cannot use
 * the same relationship variable for multiple patterns"), so sibling relationships
 * that share an attributive_label (e.g. two outbound NEXT edges off one node) must
 * each get a distinct variable or the query returns nothing.
 */
export function defaultMatchRelationshipAlias(
  query: QueryObject,
  attributiveLabel: string,
  address: { clauseIndex: number; patternIndex: number; pathIndex: number }
): string {
  const base = attributiveLabelToDefaultAlias(attributiveLabel);
  const used = collectRelationshipVariables(query, address);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function priorDefinesAlias(
  path: PathElement[],
  beforePathIndex: number,
  kind: "node" | "relationship",
  aliasName: string
): boolean {
  const want = aliasName.trim();
  if (!want) return false;
  for (let i = 0; i < beforePathIndex; i += 1) {
    const el = path[i];
    if (kind === "node" && el.kind === "node") {
      if (el.node.alias_mode === "reference") continue;
      if ((el.node.variable || "").trim() === want) return true;
    }
    if (kind === "relationship" && el.kind === "relationship") {
      if (el.relationship.alias_mode === "reference") continue;
      if ((el.relationship.variable || "").trim() === want) return true;
    }
  }
  return false;
}

/** attributive_label of the path entry that defines `aliasName`, or null if none. */
export function findDefinedAliasAttributiveLabel(
  query: QueryObject,
  kind: "node" | "relationship",
  aliasName: string
): string | null {
  const want = normalizeAlias(aliasName);
  if (!want) return null;

  for (const clause of query.match ?? []) {
    for (const pattern of clause.patterns ?? []) {
      for (const el of pattern.path ?? []) {
        if (kind === "node" && el.kind === "node") {
          if (el.node.alias_mode === "reference") continue;
          if ((el.node.variable ?? "").trim() === want) {
            return el.node.attributive_label?.trim() ?? "";
          }
        }
        if (kind === "relationship" && el.kind === "relationship") {
          if (el.relationship.alias_mode === "reference") continue;
          if ((el.relationship.variable ?? "").trim() === want) {
            return el.relationship.attributive_label?.trim() ?? "";
          }
        }
      }
    }
  }
  return null;
}

export function definedAliasExistsInQuery(
  query: QueryObject,
  kind: "node" | "relationship",
  aliasName: string
): boolean {
  return findDefinedAliasAttributiveLabel(query, kind, aliasName) !== null;
}

/** Patch fields when reusing an earlier locked alias as a reference (includes synced attributive_label). */
export function patchForAliasReference(
  query: QueryObject,
  kind: "node" | "relationship",
  aliasName: string
): {
  alias_mode: "reference";
  alias_ref: string;
  variable: string;
  alias_locked: true;
  attributive_label: string;
  properties: [];
} | null {
  const normalized = normalizeAlias(aliasName);
  const attributiveLabel = findDefinedAliasAttributiveLabel(query, kind, normalized);
  if (attributiveLabel === null) return null;
  return {
    alias_mode: "reference",
    alias_ref: normalized,
    variable: normalized,
    alias_locked: true,
    attributive_label: attributiveLabel,
    properties: []
  };
}

export function collectLockedDefineAliases(
  query: QueryObject,
  kind: "node" | "relationship",
  exclude?: { clauseIndex: number; patternIndex: number; pathIndex: number }
): string[] {
  const names: string[] = [];
  query.match.forEach((clause, ci) => {
    clause.patterns.forEach((pattern, pi) => {
      pattern.path.forEach((el, si) => {
        if (exclude && exclude.clauseIndex === ci && exclude.patternIndex === pi && exclude.pathIndex === si) {
          return;
        }
        const entity =
          kind === "node"
            ? el.kind === "node"
              ? el.node
              : null
            : el.kind === "relationship"
              ? el.relationship
              : null;
        if (
          !entity ||
          !entity.alias_locked ||
          entity.alias_mode !== "define" ||
          !entity.variable.trim()
        ) {
          return;
        }
        const v = entity.variable.trim();
        if (!names.includes(v)) names.push(v);
      });
    });
  });
  return names;
}

/**
 * Reference aliases compatible with the current slot's required attributive_label.
 *
 * When no attributive_label is selected yet, applying an existing alias is still
 * allowed: doing so adopts the referenced entry's attributive_label, so every defined
 * alias is offered. Once an attributive_label is set, references are constrained to it.
 */
export function filterAliasReferencesForRequiredAttributiveLabel(
  query: QueryObject,
  kind: "node" | "relationship",
  aliasNames: string[],
  requiredAttributiveLabel: string
): string[] {
  const required = normalizeAttributiveLabel(requiredAttributiveLabel);
  if (!required) return aliasNames;
  return aliasNames.filter((alias) => {
    const al = findDefinedAliasAttributiveLabel(query, kind, alias);
    return normalizeAttributiveLabel(al ?? "") === required;
  });
}

export function clearedMatchAliasFields(): {
  variable: string;
  alias_locked: false;
  alias_mode: undefined;
  alias_ref: undefined;
} {
  return {
    variable: "",
    alias_locked: false,
    alias_mode: undefined,
    alias_ref: undefined
  };
}
