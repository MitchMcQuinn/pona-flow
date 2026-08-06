import type { SequenceSummary } from "./types";

export const UNGROUPED_LABEL = "Ungrouped";

export interface NavGroup {
  title: string;
  /** True for the synthetic "Ungrouped" bucket (not a real, persisted group). */
  ungrouped: boolean;
  sequences: SequenceSummary[];
}

export function compareSortOrder(a: SequenceSummary, b: SequenceSummary): number {
  const ao = a.sortOrder;
  const bo = b.sortOrder;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return a.label.localeCompare(b.label);
}

/**
 * Build the ordered nav group list.
 *
 * - Named groups follow ``groupOrder`` (the persisted ``spaces.groups`` order) and are
 *   included even when they currently hold no sequences (so users can see/drop into them).
 * - Any group title found on a sequence but missing from ``groupOrder`` is appended after.
 * - The synthetic "Ungrouped" bucket always sorts last and only appears when populated.
 * - Sequences within a group are ordered by ``sortOrder``.
 */
export function buildNavGroups(
  sequences: SequenceSummary[],
  groupOrder: string[]
): NavGroup[] {
  const byTitle = new Map<string, SequenceSummary[]>();
  for (const sequence of sequences) {
    const key = sequence.groupTitle?.trim() || UNGROUPED_LABEL;
    const list = byTitle.get(key) ?? [];
    list.push(sequence);
    byTitle.set(key, list);
  }

  const orderedTitles: string[] = [];
  const seen = new Set<string>();
  for (const raw of groupOrder) {
    const title = raw.trim();
    if (!title || title === UNGROUPED_LABEL || seen.has(title)) continue;
    seen.add(title);
    orderedTitles.push(title);
  }
  // Defensive: surface any group titles that exist on sequences but not in groupOrder.
  for (const key of byTitle.keys()) {
    if (key === UNGROUPED_LABEL || seen.has(key)) continue;
    seen.add(key);
    orderedTitles.push(key);
  }

  const groups: NavGroup[] = orderedTitles.map((title) => ({
    title,
    ungrouped: false,
    sequences: (byTitle.get(title) ?? []).slice().sort(compareSortOrder)
  }));

  const ungrouped = byTitle.get(UNGROUPED_LABEL);
  if (ungrouped && ungrouped.length > 0) {
    groups.push({
      title: UNGROUPED_LABEL,
      ungrouped: true,
      sequences: ungrouped.slice().sort(compareSortOrder)
    });
  }

  return groups;
}

/** Flatten nav groups into display order (used as the basis for drag reindexing). */
export function flattenNavGroups(groups: NavGroup[]): SequenceSummary[] {
  return groups.flatMap((group) => group.sequences);
}

/** Reassign sequential ``sortOrder`` values matching the array order. */
export function reindexSequences(sequences: SequenceSummary[]): SequenceSummary[] {
  return sequences.map((sequence, index) => ({ ...sequence, sortOrder: index }));
}
