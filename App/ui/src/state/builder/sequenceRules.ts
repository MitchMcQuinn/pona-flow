import type { MatchClause, QueryObject } from "./types";

// The execution engine only supports sequences with a single entry point. A read
// query made of multiple MATCH patterns must therefore be fully connected: every
// pattern after the first has to reuse (reference) an alias that is *defined* in an
// earlier pattern. Otherwise that pattern is a second, disconnected entry point.

type AliasKind = "node" | "relationship";

/** Index of the pattern that defines `aliasName` for `kind`, or null when undefined. */
function definingPatternIndex(
  clause: MatchClause,
  kind: AliasKind,
  aliasName: string
): number | null {
  const want = aliasName.trim();
  if (!want) return null;
  for (let pi = 0; pi < clause.patterns.length; pi += 1) {
    for (const el of clause.patterns[pi].path) {
      const entity =
        kind === "node"
          ? el.kind === "node"
            ? el.node
            : null
          : el.kind === "relationship"
            ? el.relationship
            : null;
      if (!entity) continue;
      if (entity.alias_mode === "define" && (entity.variable || "").trim() === want) {
        return pi;
      }
    }
  }
  return null;
}

/** True when any element in `patternIndex` references an alias from an earlier pattern. */
function patternReferencesEarlier(clause: MatchClause, patternIndex: number): boolean {
  const pattern = clause.patterns[patternIndex];
  if (!pattern) return false;
  for (const el of pattern.path) {
    if (el.kind === "node") {
      const ref = el.node.alias_mode === "reference" ? (el.node.alias_ref || "").trim() : "";
      if (ref) {
        const di = definingPatternIndex(clause, "node", ref);
        if (di != null && di < patternIndex) return true;
      }
    } else {
      const rel = el.relationship;
      const ref = rel.alias_mode === "reference" ? (rel.alias_ref || "").trim() : "";
      if (ref) {
        const di = definingPatternIndex(clause, "relationship", ref);
        if (di != null && di < patternIndex) return true;
      }
    }
  }
  return false;
}

/**
 * Warnings for additional patterns that fail the single-entry-point rule.
 * Returns an empty array when every extra pattern back-references a previous one.
 */
export function sequenceEntryPointWarnings(query: QueryObject): string[] {
  const warnings: string[] = [];
  for (const clause of query.match ?? []) {
    if (clause.patterns.length <= 1) continue;
    for (let pi = 1; pi < clause.patterns.length; pi += 1) {
      if (!patternReferencesEarlier(clause, pi)) {
        warnings.push(
          `Pattern ${pi + 1} must reference an alias from an earlier pattern — ` +
            "sequences require a single entry point."
        );
      }
    }
  }
  return warnings;
}
