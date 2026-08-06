/**
 * View persistence + one-shot restore across refreshes.
 *
 * Owns the pending-restore refs (space/sequence/event/view read from
 * localStorage at mount) and the effects that write the current selection
 * back. The list-independent views (builder/createSequence/createEvent/space)
 * are restored here once the active space is known; sequence/event views need
 * their list to load first, so the list-load effects call the returned
 * `maybeRestoreSequence` / `maybeRestoreEvent` helpers.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import uiPersistence, { type PersistedView } from "../services/uiPersistence";
import type { AppEvent } from "../state/events";
import type { AppState, EventSummary, SequenceSummary } from "../state/types";

export function usePersistedViewRestore(state: AppState, dispatch: Dispatch<AppEvent>) {
  // Last-selected sequence to restore once on initial load (consumed after the first
  // sequences fetch for the restored space).
  const pendingSequenceRestore = useRef<string | null>(uiPersistence.getSequenceId());
  const pendingEventRestore = useRef<string | null>(uiPersistence.getEventId());
  // The top-level view to restore once on initial load. Older clients only persisted the
  // sequence id, so fall back to "sequence" when an id exists but no view tag was stored.
  const pendingViewRestore = useRef<PersistedView | null>(
    uiPersistence.getView() ?? (uiPersistence.getSequenceId() ? "sequence" : "builder")
  );
  // Gate view persistence until the initial restore has had its chance, so the transient
  // default "builder" never clobbers the saved view before it's applied.
  const [viewRestoreDone, setViewRestoreDone] = useState(false);

  useEffect(() => {
    if (state.spaceId) uiPersistence.setSpaceId(state.spaceId);
  }, [state.spaceId]);

  useEffect(() => {
    if (state.nav.selectedSequenceId) {
      uiPersistence.setSequenceId(state.nav.selectedSequenceId);
    }
  }, [state.nav.selectedSequenceId]);

  useEffect(() => {
    if (state.events.selectedEventId) {
      uiPersistence.setEventId(state.events.selectedEventId);
    }
  }, [state.events.selectedEventId]);

  // The visible top-level panel arrangement, mirroring the reducer's precedence so it
  // round-trips through localStorage. (Audit log lives inside the space panel, so it's
  // covered by "space".)
  const currentView = useMemo<PersistedView>(() => {
    if (state.spacePanelOpen) return "space";
    if (state.createEvent) return "createEvent";
    if (state.events.selectedEventId) return "event";
    if (state.createSequence) return "createSequence";
    if (state.nav.selectedSequenceId) return "sequence";
    return "builder";
  }, [
    state.spacePanelOpen,
    state.createEvent,
    state.events.selectedEventId,
    state.createSequence,
    state.nav.selectedSequenceId
  ]);

  // Restore the list-independent views (those needing no sequence/event lookup) once the
  // active space is known. Sequence/event views are restored by their list-load effects.
  useEffect(() => {
    if (!state.spaceId) return;
    const view = pendingViewRestore.current;
    if (view === null || view === "sequence" || view === "event") return;
    if (view === "createSequence") dispatch({ type: "CREATE_SEQUENCE_OPENED" });
    else if (view === "createEvent") dispatch({ type: "CREATE_EVENT_OPENED" });
    else if (view === "space") dispatch({ type: "SPACE_PANEL_OPENED" });
    // "builder" is the default state, so no dispatch is needed.
    pendingViewRestore.current = null;
    setViewRestoreDone(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId]);

  useEffect(() => {
    if (!viewRestoreDone) return;
    uiPersistence.setView(currentView);
  }, [currentView, viewRestoreDone]);

  // Restore the last-selected sequence once, but only if that was the saved view —
  // otherwise (e.g. the builder was open) we'd wrongly snap back into the sequence.
  const maybeRestoreSequence = useCallback(
    (sequences: SequenceSummary[]) => {
      if (pendingViewRestore.current !== "sequence") return;
      const restoreId = pendingSequenceRestore.current;
      if (restoreId && sequences.some((sequence) => sequence.id === restoreId)) {
        dispatch({ type: "SEQUENCE_SELECTED", sequenceId: restoreId });
      }
      pendingSequenceRestore.current = null;
      pendingViewRestore.current = null;
      setViewRestoreDone(true);
    },
    [dispatch]
  );

  // Restore the last-selected event once, if that was the saved view.
  const maybeRestoreEvent = useCallback(
    (events: EventSummary[]) => {
      if (pendingViewRestore.current !== "event") return;
      const restoreId = pendingEventRestore.current;
      if (restoreId && events.some((evt) => evt.id === restoreId)) {
        dispatch({ type: "EVENT_SELECTED", eventId: restoreId });
      }
      pendingEventRestore.current = null;
      pendingViewRestore.current = null;
      setViewRestoreDone(true);
    },
    [dispatch]
  );

  return { maybeRestoreSequence, maybeRestoreEvent };
}
