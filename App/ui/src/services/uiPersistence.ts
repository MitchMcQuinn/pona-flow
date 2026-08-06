import { GRAPH_NODE_LABELS } from "../state/builder/types";
import type { GraphNodeLabel, Operation } from "../state/builder/types";

/**
 * Lightweight localStorage persistence for UI continuity across refreshes.
 *
 * These values are cosmetic continuity hints (last selected space/operation/label and
 * panel sizes) — never authoritative data. Every accessor is defensive: storage may be
 * unavailable (private mode, disabled cookies) or hold stale/garbage values, so reads
 * validate and fall back to ``null`` rather than throwing.
 */

const KEYS = {
  spaceId: "pona-flow.ui.spaceId",
  sequenceId: "pona-flow.ui.sequenceId",
  eventId: "pona-flow.ui.eventId",
  view: "pona-flow.ui.view",
  operation: "pona-flow.ui.operation",
  label: "pona-flow.ui.label",
  navWidth: "pona-flow.ui.navWidth",
  configWidth: "pona-flow.ui.configWidth",
  matchConfigWidth: "pona-flow.ui.matchConfigWidth"
} as const;

const SCROLL_KEY_PREFIX = "pona-flow.ui.scroll.";

const OPERATIONS: readonly Operation[] = ["create", "read", "update", "delete"];

/**
 * The top-level panel arrangement currently on screen. Persisted so a refresh lands the
 * operator back on the same view (builder, a selected sequence, a selected event, the
 * space panel, or a create flow) rather than always re-deriving it from the saved ids.
 */
export type PersistedView =
  | "builder"
  | "createSequence"
  | "sequence"
  | "event"
  | "createEvent"
  | "space";

const VIEWS: readonly PersistedView[] = [
  "builder",
  "createSequence",
  "sequence",
  "event",
  "createEvent",
  "space"
];

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable/full — persistence is best-effort, so ignore.
  }
}

function readNumber(key: string): number | null {
  const raw = readRaw(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export const uiPersistence = {
  getSpaceId(): string | null {
    const raw = readRaw(KEYS.spaceId);
    return raw && raw.trim() ? raw : null;
  },
  setSpaceId(spaceId: string): void {
    if (spaceId.trim()) writeRaw(KEYS.spaceId, spaceId);
  },

  getSequenceId(): string | null {
    const raw = readRaw(KEYS.sequenceId);
    return raw && raw.trim() ? raw : null;
  },
  setSequenceId(sequenceId: string): void {
    if (sequenceId.trim()) writeRaw(KEYS.sequenceId, sequenceId);
  },

  getEventId(): string | null {
    const raw = readRaw(KEYS.eventId);
    return raw && raw.trim() ? raw : null;
  },
  setEventId(eventId: string): void {
    if (eventId.trim()) writeRaw(KEYS.eventId, eventId);
  },

  getView(): PersistedView | null {
    const raw = readRaw(KEYS.view);
    return raw && VIEWS.includes(raw as PersistedView) ? (raw as PersistedView) : null;
  },
  setView(view: PersistedView): void {
    writeRaw(KEYS.view, view);
  },

  getOperation(): Operation | null {
    const raw = readRaw(KEYS.operation);
    return raw && OPERATIONS.includes(raw as Operation) ? (raw as Operation) : null;
  },
  setOperation(operation: Operation): void {
    writeRaw(KEYS.operation, operation);
  },

  getLabel(): GraphNodeLabel | null {
    const raw = readRaw(KEYS.label);
    return raw && GRAPH_NODE_LABELS.includes(raw as GraphNodeLabel)
      ? (raw as GraphNodeLabel)
      : null;
  },
  setLabel(label: GraphNodeLabel): void {
    writeRaw(KEYS.label, label);
  },

  getNavWidth(): number | null {
    return readNumber(KEYS.navWidth);
  },
  setNavWidth(width: number): void {
    if (Number.isFinite(width)) writeRaw(KEYS.navWidth, String(Math.round(width)));
  },

  getConfigWidth(): number | null {
    return readNumber(KEYS.configWidth);
  },
  setConfigWidth(width: number): void {
    if (Number.isFinite(width)) writeRaw(KEYS.configWidth, String(Math.round(width)));
  },

  getMatchConfigWidth(): number | null {
    return readNumber(KEYS.matchConfigWidth);
  },
  setMatchConfigWidth(width: number): void {
    if (Number.isFinite(width)) writeRaw(KEYS.matchConfigWidth, String(Math.round(width)));
  },

  getScroll(name: string): number | null {
    const raw = readRaw(SCROLL_KEY_PREFIX + name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  },
  setScroll(name: string, top: number): void {
    if (Number.isFinite(top)) writeRaw(SCROLL_KEY_PREFIX + name, String(Math.round(top)));
  }
};

export default uiPersistence;
