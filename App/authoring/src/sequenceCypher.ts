/**
 * Sequence read-query scanners shared by hybrid operation rename and the UI.
 *
 * Mirrors Engine/server/cypher_utils.py ``cypher_traverses_downstream`` and
 * Engine/server/spaces.py ``_parse_sequence_cypher_labels`` so authoring can
 * decide wrap retargets without a round trip to those helpers.
 */

/** A ``-[...]->`` relationship pattern means the sequence walks past its initial STEP. */
const STEP_TRAVERSAL_RE = /-\s*\[/;

/** ``(alias:STEP { attributive_label: 'X' })`` and the double-quoted form. */
const SEQUENCE_STEP_LABEL_RE =
  /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/gi;

function statementsOf(cypher: unknown): string[] {
  if (typeof cypher === "string") return cypher.trim() ? [cypher] : [];
  if (!Array.isArray(cypher)) return [];
  return cypher.map((stmt) => String(stmt ?? ""));
}

/** True when a sequence's read query walks beyond its initial STEP node. */
export function cypherTraversesDownstream(cypher: unknown): boolean {
  return statementsOf(cypher).some((stmt) => STEP_TRAVERSAL_RE.test(stmt));
}

/** attributive_labels of STEP nodes a sequence query matches, in order of appearance. */
export function sequenceStepLabels(cypher: unknown): string[] {
  const out: string[] = [];
  for (const stmt of statementsOf(cypher)) {
    const re = new RegExp(SEQUENCE_STEP_LABEL_RE.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(stmt))) {
      const label = (match[1] || "").trim();
      if (label) out.push(label);
    }
  }
  return out;
}

/** True when any STEP match in the sequence Cypher names ``label``. */
export function sequenceReferencesStepLabel(cypher: unknown, label: string): boolean {
  const target = (label || "").trim();
  if (!target) return false;
  return sequenceStepLabels(cypher).includes(target);
}

export type CatalogNameRow = {
  id: string;
  name: string;
  kind: string;
  cypher?: unknown;
};

/**
 * A one-step sequence whose MATCH names this operation wrap. Pairing is by Cypher
 * identity, not by whether the two catalog titles currently match.
 */
export function isPairedOneStepSequence(
  row: Pick<CatalogNameRow, "kind" | "cypher">,
  wrapLabel: string
): boolean {
  return (
    row.kind === "sequence" &&
    !cypherTraversesDownstream(row.cypher) &&
    sequenceReferencesStepLabel(row.cypher, wrapLabel)
  );
}

export function pairedOneStepSequences<T extends Pick<CatalogNameRow, "kind" | "cypher">>(
  rows: T[],
  wrapLabel: string
): T[] {
  return rows.filter((row) => isPairedOneStepSequence(row, wrapLabel));
}

/**
 * Catalog titles that would collide with an operation rename. The operation row and its
 * paired one-step sequence (MATCH wrap, or same title as when editing started) are excluded
 * so the shared name is not treated as already taken.
 */
export function catalogNamesTakenForOperationRename(opts: {
  rows: CatalogNameRow[];
  operationId: string;
  wrapLabel?: string;
  originalName?: string;
}): Set<string> {
  const operationId = (opts.operationId || "").trim();
  const wrapLabel = (opts.wrapLabel || "").trim();
  const originalName = (opts.originalName || "").trim().toLowerCase();
  const excluded = new Set<string>();
  if (operationId) excluded.add(operationId);
  for (const row of opts.rows) {
    if (row.kind !== "sequence") continue;
    if (wrapLabel && isPairedOneStepSequence(row, wrapLabel)) {
      excluded.add(row.id);
      continue;
    }
    if (originalName && row.name.trim().toLowerCase() === originalName) {
      excluded.add(row.id);
    }
  }
  const taken = new Set<string>();
  for (const row of opts.rows) {
    if (excluded.has(row.id)) continue;
    if (row.kind !== "sequence" && row.kind !== "operation") continue;
    const name = row.name.trim().toLowerCase();
    if (name) taken.add(name);
  }
  return taken;
}
