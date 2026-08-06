/**
 * Events lifecycle for App: the per-space events list load (with the one-shot
 * persisted-view restore) and the save/delete handlers that resync the list.
 */

import { useEffect, type Dispatch } from "react";
import { deleteEvent, fetchEvents } from "../services/api";
import type { AppEvent } from "../state/events";
import type { AppState, EventSummary } from "../state/types";

export function useEventsNav(options: {
  state: AppState;
  dispatch: Dispatch<AppEvent>;
  /** One-shot restore of the persisted event view after the first list load. */
  maybeRestoreEvent: (events: EventSummary[]) => void;
}) {
  const { state, dispatch, maybeRestoreEvent } = options;

  useEffect(() => {
    if (!state.spaceId) return;
    let cancelled = false;
    dispatch({ type: "EVENTS_LOAD_STARTED" });
    fetchEvents(state.spaceId)
      .then((events) => {
        if (cancelled) return;
        dispatch({ type: "EVENTS_LOAD_SUCCEEDED", events });
        maybeRestoreEvent(events);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "EVENTS_LOAD_FAILED",
            error: error instanceof Error ? error.message : "Unable to load events"
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId]);

  function reloadEvents() {
    if (!state.spaceId) return;
    fetchEvents(state.spaceId)
      .then((events) => dispatch({ type: "EVENTS_LOAD_SUCCEEDED", events }))
      .catch(() => undefined);
  }

  function handleEventSaved() {
    reloadEvents();
    dispatch({ type: "EVENT_DESELECTED" });
  }

  function handleEventDeleted() {
    reloadEvents();
    dispatch({ type: "EVENT_DESELECTED" });
  }

  async function handleDeleteEvent(eventId: string) {
    const target = state.events.items.find((item) => item.id === eventId);
    if (!window.confirm(`Delete event "${target?.name ?? eventId}"?`)) return;
    try {
      await deleteEvent(eventId);
      if (state.events.selectedEventId === eventId) {
        dispatch({ type: "EVENT_DESELECTED" });
      }
      reloadEvents();
    } catch {
      // Non-fatal: leave the nav as-is; the next space refresh will resync.
    }
  }

  return { handleEventSaved, handleEventDeleted, handleDeleteEvent };
}
