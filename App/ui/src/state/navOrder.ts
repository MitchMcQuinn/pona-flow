import type { SequenceSummary } from "./types";

export const UNGROUPED_LABEL = "Ungrouped";

/** A nav row that can sit in a named group or in the ungrouped tail. */
export interface GroupableNavItem {
  id: string;
  groupTitle: string | null;
  sortOrder: number | null;
}

export interface NavGroup<T extends GroupableNavItem = GroupableNavItem> {
  title: string;
  /** True for the synthetic "Ungrouped" bucket (not a real, persisted group). */
  ungrouped: boolean;
  items: T[];
}

export function compareSortOrder<T extends GroupableNavItem>(
  labelOf: (item: T) => string
): (a: T, b: T) => number {
  return (a, b) => {
    const ao = a.sortOrder;
    const bo = b.sortOrder;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return labelOf(a).localeCompare(labelOf(b));
  };
}

/**
 * Build the ordered nav group list.
 *
 * - Named groups follow ``groupOrder`` and are included even when empty (so users can
 *   see them and drop into them).
 * - Any group title found on an item but missing from ``groupOrder`` is appended after.
 * - The synthetic "Ungrouped" bucket always sorts last and only appears when populated.
 *   The nav renders those items as a flat list under the named groups, with no header.
 * - Items within a group are ordered by ``sortOrder``.
 */
export function buildNavGroups<T extends GroupableNavItem>(
  entries: T[],
  groupOrder: string[],
  labelOf: (item: T) => string
): NavGroup<T>[] {
  const byTitle = new Map<string, T[]>();
  for (const entry of entries) {
    const key = entry.groupTitle?.trim() || UNGROUPED_LABEL;
    const list = byTitle.get(key) ?? [];
    list.push(entry);
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
  // Defensive: surface any group titles that exist on items but not in groupOrder.
  for (const key of byTitle.keys()) {
    if (key === UNGROUPED_LABEL || seen.has(key)) continue;
    seen.add(key);
    orderedTitles.push(key);
  }

  const order = compareSortOrder(labelOf);
  const groups: NavGroup<T>[] = orderedTitles.map((title) => ({
    title,
    ungrouped: false,
    items: (byTitle.get(title) ?? []).slice().sort(order)
  }));

  const ungrouped = byTitle.get(UNGROUPED_LABEL);
  if (ungrouped && ungrouped.length > 0) {
    groups.push({
      title: UNGROUPED_LABEL,
      ungrouped: true,
      items: ungrouped.slice().sort(order)
    });
  }

  return groups;
}

/** Flatten nav groups into display order (used as the basis for drag reindexing). */
export function flattenNavGroups<T extends GroupableNavItem>(groups: NavGroup<T>[]): T[] {
  return groups.flatMap((group) => group.items);
}

/** Reassign sequential ``sortOrder`` values matching the array order. */
export function reindexSequences<T extends GroupableNavItem>(entries: T[]): T[] {
  return entries.map((entry, index) => ({ ...entry, sortOrder: index }));
}

/**
 * Delete a named group by moving its items onto the ungrouped tail (after anything
 * already ungrouped) and reindexing.
 */
export function moveGroupToUngrouped<T extends GroupableNavItem>(
  entries: T[],
  groupOrder: string[],
  title: string,
  labelOf: (item: T) => string
): T[] {
  const display = flattenNavGroups(buildNavGroups(entries, groupOrder, labelOf));
  const kept = display.filter((entry) => (entry.groupTitle ?? null) !== title);
  const moved = display
    .filter((entry) => (entry.groupTitle ?? null) === title)
    .map((entry) => ({ ...entry, groupTitle: null }));
  return reindexSequences([...kept, ...moved]);
}

/** True when a nav row is a one-step (synthetic) sequence wrap around a single STEP. */
export function isSingleStepSequence(sequence: SequenceSummary): boolean {
  return sequence.kind === "sequence" && Boolean(sequence.singleStep);
}
