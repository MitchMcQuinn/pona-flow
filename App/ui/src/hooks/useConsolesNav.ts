import { useEffect, type Dispatch } from "react";
import { createLiveView } from "../consoles/views";
import {
  deleteConsole,
  fetchConsoles,
  fetchNavGroups,
  generateId,
  reorderConsoles,
  saveConsole,
  setSpaceGroups
} from "../services/api";
import { confirmDialog } from "../components/modals/confirmDialog";
import type { AppEvent } from "../state/events";
import { moveGroupToUngrouped } from "../state/navOrder";
import type { AppState, ConsoleNavItem } from "../state/types";

export function useConsolesNav(options: { state: AppState; dispatch: Dispatch<AppEvent> }) {
  const { state, dispatch } = options;

  useEffect(() => {
    if (!state.spaceId) return;
    let cancelled = false;
    dispatch({ type: "CONSOLES_LOAD_STARTED" });
    fetchConsoles(state.spaceId)
      .then((consoles) => {
        if (!cancelled) dispatch({ type: "CONSOLES_LOAD_SUCCEEDED", consoles });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "CONSOLES_LOAD_FAILED",
            error: error instanceof Error ? error.message : "Unable to load consoles"
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId]);

  function reloadConsoles() {
    if (!state.spaceId) return;
    fetchConsoles(state.spaceId)
      .then((consoles) => dispatch({ type: "CONSOLES_LOAD_SUCCEEDED", consoles }))
      .catch(() => undefined);
  }

  function reload() {
    if (!state.spaceId) return;
    fetchConsoles(state.spaceId)
      .then((consoles) => dispatch({ type: "CONSOLES_LOAD_SUCCEEDED", consoles }))
      .catch(() => undefined);
  }

  async function handleCreateConsole() {
    if (!state.spaceId) return;
    const id = await generateId();
    const view = createLiveView("Live");
    await saveConsole({
      id,
      spaceId: state.spaceId,
      name: "Console",
      triggerKind: "",
      listenUrl: "",
      triggerEventId: "",
      document: { views: [view], activeViewId: view.id }
    });
    reload();
    dispatch({ type: "CONSOLE_SELECTED", consoleId: id });
  }

  async function handleDeleteConsole(consoleId: string) {
    const target = state.consoles.items.find((item) => item.id === consoleId);
    if (!(await confirmDialog(`Delete console "${target?.name ?? consoleId}"?`))) return;
    try {
      await deleteConsole(consoleId);
      if (state.consoles.selectedConsoleId === consoleId) {
        dispatch({ type: "CONSOLE_DESELECTED" });
      }
      reload();
    } catch {
      // Leave the nav as-is; the next space refresh resyncs the list.
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
    setSpaceGroups(state.spaceId, groups, "consoles").catch(() => reloadGroups());
  }

  function persistOrder(reordered: ConsoleNavItem[]) {
    reorderConsoles(
      reordered.map((console) => ({
        id: console.id,
        groupTitle: console.groupTitle,
        sortOrder: console.sortOrder ?? 0
      }))
    ).catch(() => reload());
  }

  function handleReorderConsoles(reordered: ConsoleNavItem[]) {
    dispatch({ type: "CONSOLES_REORDERED", consoles: reordered });
    persistOrder(reordered);
  }

  function handleReorderConsoleGroups(groups: string[]) {
    dispatch({ type: "CONSOLE_GROUPS_CHANGED", groups });
    persistGroups(groups);
  }

  function handleAddConsoleGroup(title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (state.consoles.groups.some((group) => group.toLowerCase() === trimmed.toLowerCase())) return;
    handleReorderConsoleGroups([...state.consoles.groups, trimmed]);
  }

  async function handleDeleteConsoleGroup(title: string) {
    const affected = state.consoles.items.filter((console) => (console.groupTitle ?? null) === title);
    if (
      affected.length > 0 &&
      !(await confirmDialog(`Delete group "${title}"? Its consoles will become ungrouped.`))
    ) {
      return;
    }
    const groups = state.consoles.groups.filter((group) => group !== title);
    if (affected.length === 0) {
      dispatch({ type: "CONSOLE_GROUPS_CHANGED", groups });
      persistGroups(groups);
      return;
    }
    const reordered = moveGroupToUngrouped(
      state.consoles.items,
      state.consoles.groups,
      title,
      (console) => console.name
    );
    dispatch({ type: "CONSOLE_GROUPS_CHANGED", groups, consoles: reordered });
    persistGroups(groups);
    persistOrder(reordered);
  }

  return {
    reloadConsoles,
    handleCreateConsole,
    handleDeleteConsole,
    handleReorderConsoles,
    handleReorderConsoleGroups,
    handleAddConsoleGroup,
    handleDeleteConsoleGroup
  };
}
