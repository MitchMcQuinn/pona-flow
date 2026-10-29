/**
 * Events lifecycle for App: the per-space events list load (with the one-shot
 * persisted-view restore) and the save/delete handlers that resync the list.
 */

import { useEffect, type Dispatch } from "react";
import { deleteEvent, fetchEvents, fetchNavGroups, reorderEvents, setSpaceGroups } from "../services/api";
import { confirmDialog } from "../components/modals/confirmDialog";
import type { AppEvent } from "../state/events";
import { moveGroupToUngrouped } from "../state/navOrder";
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
    if (!(await confirmDialog(`Delete event "${target?.name ?? eventId}"?`))) return;
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

  function reloadGroups() {
    if (!state.spaceId) return;
    fetchNavGroups(state.spaceId)
      .then((loaded) =>
        dispatch({
          type: "GROUPS_LOADED",
          groups: loaded.groups,
          eventGroups: loaded.eventGroups,
          consoleGroups: loaded.consoleGroups
        })
      )
      .catch(() => undefined);
  }

  function persistGroups(groups: string[]) {
    if (!state.spaceId) return;
    setSpaceGroups(state.spaceId, groups, "events").catch(() => reloadGroups());
  }

  function persistOrder(reordered: EventSummary[]) {
    reorderEvents(
      reordered.map((event) => ({
        id: event.id,
        groupTitle: event.groupTitle,
        sortOrder: event.sortOrder ?? 0
      }))
    ).catch(() => reloadEvents());
  }

  function handleReorderEvents(reordered: EventSummary[]) {
    dispatch({ type: "EVENTS_REORDERED", events: reordered });
    persistOrder(reordered);
  }

  function handleReorderEventGroups(groups: string[]) {
    dispatch({ type: "EVENT_GROUPS_CHANGED", groups });
    persistGroups(groups);
  }

  function handleAddEventGroup(title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (state.events.groups.some((group) => group.toLowerCase() === trimmed.toLowerCase())) return;
    handleReorderEventGroups([...state.events.groups, trimmed]);
  }

  async function handleDeleteEventGroup(title: string) {
    const affected = state.events.items.filter((event) => (event.groupTitle ?? null) === title);
    if (
      affected.length > 0 &&
      !(await confirmDialog(`Delete group "${title}"? Its events will become ungrouped.`))
    ) {
      return;
    }
    const groups = state.events.groups.filter((group) => group !== title);
    if (affected.length === 0) {
      dispatch({ type: "EVENT_GROUPS_CHANGED", groups });
      persistGroups(groups);
      return;
    }
    const reordered = moveGroupToUngrouped(
      state.events.items,
      state.events.groups,
      title,
      (event) => event.name
    );
    dispatch({ type: "EVENT_GROUPS_CHANGED", groups, events: reordered });
    persistGroups(groups);
    persistOrder(reordered);
  }

  return {
    reloadEvents,
    handleEventSaved,
    handleEventDeleted,
    handleDeleteEvent,
    handleReorderEvents,
    handleReorderEventGroups,
    handleAddEventGroup,
    handleDeleteEventGroup
  };
}
