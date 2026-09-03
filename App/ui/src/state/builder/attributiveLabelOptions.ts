import { normalizeAttributiveLabel } from "@pona-flow/authoring";

function sortUniqueLabels(labels: string[]): string[] {
  return Array.from(new Set(labels.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

/** Normalized keys for labels registered in ``spaces.labels``. */
export function spaceCatalogLabelKeys(catalogLabels: string[]): Set<string> {
  return new Set(catalogLabels.map((l) => normalizeAttributiveLabel(l)).filter(Boolean));
}

export function isRegisteredInSpaceCatalog(
  attributiveLabel: string,
  catalogKeys: Set<string>
): boolean {
  if (!catalogKeys.size) return false;
  return catalogKeys.has(normalizeAttributiveLabel(attributiveLabel));
}

/** Options that exist on graph nodes/relationships and in the active space label catalog. */
export function intersectGraphLabelsWithCatalog(
  graphLabels: string[],
  catalogLabels: string[]
): string[] {
  const catalogKeys = spaceCatalogLabelKeys(catalogLabels);
  if (!catalogKeys.size || !graphLabels.length) return [];
  return sortUniqueLabels(
    graphLabels.filter((al) => isRegisteredInSpaceCatalog(al, catalogKeys))
  );
}

/** @deprecated Use {@link intersectGraphLabelsWithCatalog}. */
export function buildStepCatalogLabelOptions(
  graphLabels: string[],
  catalogLabels: string[]
): string[] {
  return intersectGraphLabelsWithCatalog(graphLabels, catalogLabels);
}

/**
 * How a STEP node's attributive_label resolves at runtime, so the picker can show
 * whether a label backs a raw HTTP endpoint, a saved operation, or a sequence.
 */
export type StepLabelKind = "endpoint" | "operation" | "sequence" | "system" | "unknown";

export interface StepLabelOption {
  value: string;
  kind: StepLabelKind;
  /** The backing query is suspended (a SCHEMA change invalidated it); not runnable until re-saved. */
  suspended?: boolean;
}

/** Minimal shape of a fetched graph node row (mirrors connector's GraphNodeRow). */
interface StepLabelRow {
  attributive_label: string;
  sequencial_properties?: { query_id?: string };
}

/** Catalog rows that expose the runtime ``kind`` of a saved query/operation/sequence. */
interface SavedQueryKind {
  id: string;
  kind: string;
  suspended?: boolean;
}

/**
 * Resolve each STEP node label to its runtime kind. A node with no ``query_id`` is a
 * raw custom endpoint; otherwise the kind comes from the matching catalog row
 * (``operation`` / ``sequence`` / ``system``). When ``requireSpaceCatalog`` is set the
 * result is limited to labels also registered in ``spaces.labels`` (matches the plain
 * picker's intersection behavior).
 */
export function buildStepLabelOptions(
  rows: StepLabelRow[],
  catalogLabels: string[],
  savedQueries: SavedQueryKind[],
  requireSpaceCatalog: boolean
): StepLabelOption[] {
  const byQueryId = new Map(savedQueries.map((q) => [q.id, q]));
  const catalogKeys = spaceCatalogLabelKeys(catalogLabels);
  const seen = new Map<string, { kind: StepLabelKind; suspended: boolean }>();

  for (const row of rows) {
    const label = (row.attributive_label || "").trim();
    if (!label) continue;
    if (requireSpaceCatalog && !isRegisteredInSpaceCatalog(label, catalogKeys)) continue;

    const queryId = (row.sequencial_properties?.query_id || "").trim();
    let kind: StepLabelKind;
    let suspended = false;
    if (!queryId) {
      kind = "endpoint";
    } else {
      const catalogRow = byQueryId.get(queryId);
      const catalogKind = catalogRow?.kind;
      suspended = Boolean(catalogRow?.suspended);
      kind =
        catalogKind === "sequence"
          ? "sequence"
          : catalogKind === "system"
            ? "system"
            : catalogKind === "operation" || catalogKind === "user"
              ? "operation"
              : "unknown";
    }

    const prev = seen.get(label);
    if (prev) {
      // Duplicate graph nodes can share a label when a prior auto-wrap MERGE'd a fresh id
      // without an entity row; prefer the operation-backed node over the orphan endpoint.
      if (prev.kind === "endpoint" && kind !== "endpoint") {
        seen.set(label, { kind, suspended });
      }
      continue;
    }
    seen.set(label, { kind, suspended });
  }

  return Array.from(seen.entries())
    .map(([value, { kind, suspended }]) => ({ value, kind, suspended }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Drop sequence-backed STEPs when building a sequence.
 *
 * A sequence cannot contain another sequence: the nested chain has its own entry point
 * and its own loop policy, neither of which can be reconciled with the parent's. Compose
 * rejects it outright, so keeping those labels out of the picker is what turns a hard
 * failure at run time into an option that was never offered.
 */
export function excludeSequenceStepOptions(options: StepLabelOption[]): StepLabelOption[] {
  return options.filter((option) => option.kind !== "sequence");
}

/**
 * Picker display text for a STEP attributive_label. Kind annotations (operation /
 * endpoint / sequence) disambiguate overlapping labels in the match builder.
 * Sequence authoring already excludes nested sequences, so the kind suffix is omitted
 * there; a suspended backing query is still called out.
 */
export function formatStepOptionLabel(
  option: StepLabelOption,
  annotateKind: boolean
): string {
  if (!annotateKind) {
    return option.suspended ? `${option.value}  (suspended)` : option.value;
  }
  return `${option.value}  (${option.kind}${option.suspended ? " · suspended" : ""})`;
}
