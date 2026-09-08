/**
 * Join STEP authoring helpers.
 *
 * A join is a barrier: incoming POINTS_TO edges are the arms, and the outgoing
 * edge is "then". There are no duration / URL fields; compose rejects a join
 * inside a loop body or a join that can reach another join.
 */

import type { SequencialProperties } from "./types.js";

export function isJoinStep(sp: SequencialProperties | null | undefined): boolean {
  return Boolean(sp && sp.query_id === undefined && sp.step_type === "join");
}

/**
 * Shape problems the builder can see on its own. Empty array = complete enough to save.
 * Graph-level checks (inbound edges, join-in-loop, nested joins) are compose-only.
 */
export function joinStepWarnings(sp: SequencialProperties | null | undefined): string[] {
  if (!isJoinStep(sp)) return [];
  return [];
}
