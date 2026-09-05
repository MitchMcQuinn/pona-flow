/**
 * Picker options for outbound STEP POINTS_TO edges.
 *
 * NEXT is reused on every STEP-to-STEP link, so a bare attributive_label is not
 * unique. Siblings that share a label but go to different targets are shown as
 * "NEXT → TARGET". Two edges between the *same* pair (conditional branches, or
 * a duplicate NEXT) are listed separately, keyed by relationship id, so a
 * delete/update can target one without taking the other.
 */

import type { StepOutgoingEdge } from "../../../services/connector";

export interface StepOutgoingEdgePickerOpts {
  /**
   * When false, siblings that share both rel label and target collapse to one
   * option (read MATCH is label-only, so listing both would be a lie). Delete
   * and update keep them separate so each POINTS_TO can be targeted by id.
   */
  distinguishParallelPairs?: boolean;
}

export interface StepOutgoingEdgeOption {
  value: string;
  label: string;
  edge: StepOutgoingEdge;
}

function relLabel(edge: StepOutgoingEdge): string {
  return (edge.rel_attributive_label || "").trim();
}

function targetLabel(edge: StepOutgoingEdge): string {
  return (edge.target_attributive_label || "").trim();
}

function relId(edge: StepOutgoingEdge): string {
  return (edge.rel_id || "").trim();
}

/** Compact guard caption, or "" when the edge is unconditional. */
export function stepEdgeConditionCaption(edge: StepOutgoingEdge): string {
  const type = (edge.condition_type || "").trim();
  const condition = (edge.condition || "").trim();
  if (type === "parameter" && condition) {
    const expected = edge.condition_expected === false ? "false" : "true";
    return `${condition} is ${expected}`;
  }
  return condition;
}

function shortRelId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(-8);
}

function pairKey(edge: StepOutgoingEdge): string {
  return `${relLabel(edge)}|${targetLabel(edge)}`;
}

/**
 * One picker row per catalog edge. Values stay stable for the common unique-label
 * case (`NEXT`) and only become composite when siblings would otherwise collide.
 */
export function stepOutgoingEdgePickerOptions(
  edges: StepOutgoingEdge[],
  opts: StepOutgoingEdgePickerOpts = {}
): StepOutgoingEdgeOption[] {
  const distinguishParallelPairs = opts.distinguishParallelPairs !== false;
  const relCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    const relAl = relLabel(edge);
    const targetAl = targetLabel(edge);
    if (!relAl || !targetAl) continue;
    relCounts.set(relAl, (relCounts.get(relAl) ?? 0) + 1);
    const pair = pairKey(edge);
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  const list: StepOutgoingEdgeOption[] = [];
  const seenValues = new Set<string>();
  edges.forEach((edge, index) => {
    const relAl = relLabel(edge);
    const targetAl = targetLabel(edge);
    if (!relAl || !targetAl) return;
    const ambiguousRel = (relCounts.get(relAl) ?? 0) > 1;
    const ambiguousPair =
      distinguishParallelPairs && (pairCounts.get(pairKey(edge)) ?? 0) > 1;
    const id = relId(edge);
    let value: string;
    if (ambiguousPair) {
      value = id || `${relAl}|${targetAl}|${index}`;
    } else if (ambiguousRel) {
      value = `${relAl}|${targetAl}`;
    } else {
      value = relAl;
    }
    if (seenValues.has(value)) return;
    seenValues.add(value);
    let label = relAl;
    if (ambiguousRel) label = `${relAl} → ${targetAl}`;
    if (ambiguousPair) {
      const caption = stepEdgeConditionCaption(edge);
      if (caption) label = `${label} (${caption})`;
      else if (id) label = `${label} (${shortRelId(id)})`;
      else label = `${label} (unconditional)`;
    }
    list.push({ value, label, edge });
  });
  return list.sort((a, b) => a.label.localeCompare(b.label));
}

/** Reconstruct the picker's selected value from the bound rel label / target / id. */
export function selectedStepOutgoingEdgeValue(
  options: StepOutgoingEdgeOption[],
  attributiveLabel: string,
  targetAttributiveLabel: string,
  relationshipId = ""
): string {
  const relIdWanted = relationshipId.trim();
  if (relIdWanted) {
    const byId = options.find((o) => relId(o.edge) === relIdWanted);
    if (byId) return byId.value;
  }
  const relAl = attributiveLabel.trim();
  if (!relAl) return attributiveLabel;
  const target = targetAttributiveLabel.trim();
  const exact = options.find(
    (o) => relLabel(o.edge) === relAl && targetLabel(o.edge) === target
  );
  if (exact) return exact.value;
  const byRel = options.find((o) => relLabel(o.edge) === relAl);
  return byRel ? byRel.value : attributiveLabel;
}
