/**
 * Sequence read-query scanners shared by hybrid operation rename and the UI.
 *
 * Mirrors Engine/server/cypher_utils.py ``cypher_traverses_downstream`` and
 * Engine/server/spaces.py ``_parse_sequence_cypher_labels`` so authoring can
 * decide wrap retargets without a round trip to those helpers.
 */

/** A ``-[...]->`` relationship pattern means the sequence walks past its initial STEP. */
const STEP_TRAVERSAL_RE = /-\s*\[/;

/** ``:STEP { attributive_label: 'X' }`` (and the double-quoted form). */
const SEQUENCE_STEP_LABEL_RE = /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/gi;

function statementsOf(cypher: unknown): string[] {
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
