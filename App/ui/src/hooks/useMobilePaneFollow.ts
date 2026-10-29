import { useCallback, useEffect, useRef, useState } from "react";
import type { MobilePane } from "../components/layout/ResizableDashboardLayout";
import type { BuilderSeed, RunResult } from "../state/builder/types";
import type { AppState } from "../state/types";
import type { ViewportMode } from "./useViewport";

interface Options {
  mode: ViewportMode;
  state: AppState;
  builderResult: RunResult | null;
  builderSeed: BuilderSeed | null;
  /** Chat mode keeps the phone on Chat/Canvas and does not follow classic pane changes. */
  chatMode?: boolean;
}

/**
 * Phones show one pane at a time, so actions that open something in another pane switch to
 * it (picking a sequence opens the workbench; a finished run shows the map). Tablets close
 * the nav drawer for the same actions. Results that arrive while another pane is showing
 * flag the Map tab instead of yanking the screen away mid-edit.
 */
export function useMobilePaneFollow({ mode, state, builderResult, builderSeed, chatMode = false }: Options) {
  const [mobilePane, setMobilePaneState] = useState<MobilePane>("menu");
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [mapUnseen, setMapUnseen] = useState(false);

  const paneRef = useRef(mobilePane);
  paneRef.current = mobilePane;

  const setMobilePane = useCallback((pane: MobilePane) => {
    setMobilePaneState(pane);
    if (pane === "map") setMapUnseen(false);
  }, []);

  const openWorkbench = useCallback(() => {
    if (mode === "phone") setMobilePane("workbench");
    if (mode === "tablet") setNavDrawerOpen(false);
  }, [mode, setMobilePane]);

  useEffect(() => {
    if (mode !== "tablet") setNavDrawerOpen(false);
  }, [mode]);

  const { selectedSequenceId } = state.nav;
  const { selectedEventId, editNonce: eventEditNonce } = state.events;
  const { selectedConsoleId, editNonce: consoleEditNonce } = state.consoles;
  const { rightPanelMode } = state.view;
  const { createSequence } = state;
  const awaitingParams = state.run.awaitingParams;
  const runStatus = state.run.status;

  const prev = useRef({
    selectedSequenceId,
    selectedEventId,
    eventEditNonce,
    selectedConsoleId,
    consoleEditNonce,
    rightPanelMode,
    createSequence,
    awaitingParams,
    builderSeed,
    builderResult,
    runStatus
  });

  useEffect(() => {
    if (chatMode) {
      if (paneRef.current === "workbench") setMobilePane("menu");
      prev.current = {
        selectedSequenceId,
        selectedEventId,
        eventEditNonce,
        selectedConsoleId,
        consoleEditNonce,
        rightPanelMode,
        createSequence,
        awaitingParams,
        builderSeed,
        builderResult,
        runStatus
      };
      return;
    }
    const p = prev.current;
    const consoleOpened =
      Boolean(selectedConsoleId) &&
      (selectedConsoleId !== p.selectedConsoleId || consoleEditNonce !== p.consoleEditNonce);
    const opened =
      !consoleOpened &&
      ((selectedSequenceId && selectedSequenceId !== p.selectedSequenceId) ||
        (selectedEventId &&
          (selectedEventId !== p.selectedEventId || eventEditNonce !== p.eventEditNonce)) ||
        (rightPanelMode !== p.rightPanelMode && rightPanelMode !== "params") ||
        (createSequence && !p.createSequence) ||
        (awaitingParams && !p.awaitingParams) ||
        (builderSeed && builderSeed !== p.builderSeed));
    if (consoleOpened) {
      if (mode === "phone") setMobilePane("map");
      if (mode === "tablet") setNavDrawerOpen(false);
    } else if (opened) openWorkbench();

    if (builderResult && builderResult !== p.builderResult && mode === "phone") {
      // A topbar run lands its answer on the map; builder test-runs only flag it.
      if (p.runStatus === "running" && !awaitingParams) setMobilePane("map");
      else if (paneRef.current !== "map") setMapUnseen(true);
    }

    prev.current = {
      selectedSequenceId,
      selectedEventId,
      eventEditNonce,
      selectedConsoleId,
      consoleEditNonce,
      rightPanelMode,
      createSequence,
      awaitingParams,
      builderSeed,
      builderResult,
      runStatus
    };
  }, [
    selectedSequenceId,
    selectedEventId,
    eventEditNonce,
    selectedConsoleId,
    consoleEditNonce,
    rightPanelMode,
    createSequence,
    awaitingParams,
    builderSeed,
    builderResult,
    runStatus,
    mode,
    chatMode,
    openWorkbench,
    setMobilePane,
    setNavDrawerOpen
  ]);

  return {
    mobilePane,
    setMobilePane,
    navDrawerOpen,
    setNavDrawerOpen,
    unseen: { map: mapUnseen }
  };
}
