/**
 * Nav activity icon: which catalog sequences are actually running in the background.
 *
 * Match only ``sequence_id`` (the catalog query id on the state row). Sequences that
 * share a STEP — a one-step wait wrap and a longer chain that starts at that wait —
 * must not share the spinner. Pending HITL is excluded: leftover pauses from an
 * earlier run would otherwise keep spinning on a sequence that is not waiting.
 */

export type NavActivityRun = {
  sequence_id?: string | null;
  status?: string | null;
};

export function navActivitySequenceIds(runs: NavActivityRun[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (run.status !== "waiting" && run.status !== "active") continue;
    const id = String(run.sequence_id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
