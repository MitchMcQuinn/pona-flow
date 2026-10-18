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
}

/**
 * Phones show one pane at a time, so actions that open something in another pane switch to
 * it (picking a sequence opens the workbench; a finished run shows the map). Tablets close
 * the nav drawer for the same actions. Results that arrive while another pane is showing
 * flag the Map tab instead of yanking the screen away mid-edit.
 */
export function useMobilePaneFollow({ mode, state, builderResult, builderSeed }: Options) {
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
  const { selectedEventId } = state.events;
  const { rightPanelMode } = state.view;
  const { createSequence } = state;
  const awaitingParams = state.run.awaitingParams;
  const runStatus = state.run.status;

  const prev = useRef({
    selectedSequenceId,
    selectedEventId,
    rightPanelMode,
    createSequence,
    awaitingParams,
    builderSeed,
    builderResult,
    runStatus
  });

  useEffect(() => {
    const p = prev.current;
    const opened =
      (selectedSequenceId && selectedSequenceId !== p.selectedSequenceId) ||
      (selectedEventId && selectedEventId !== p.selectedEventId) ||
      (rightPanelMode !== p.rightPanelMode && rightPanelMode !== "params") ||
      (createSequence && !p.createSequence) ||
      (awaitingParams && !p.awaitingParams) ||
      (builderSeed && builderSeed !== p.builderSeed);
    if (opened) openWorkbench();

    if (builderResult && builderResult !== p.builderResult && mode === "phone") {
      // A topbar run lands its answer on the map; builder test-runs only flag it.
      if (p.runStatus === "running" && !awaitingParams) setMobilePane("map");
      else if (paneRef.current !== "map") setMapUnseen(true);
    }

    prev.current = {
      selectedSequenceId,
      selectedEventId,
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
    rightPanelMode,
    createSequence,
    awaitingParams,
    builderSeed,
    builderResult,
    runStatus,
    mode,
    openWorkbench,
    setMobilePane
  ]);

  return {
    mobilePane,
    setMobilePane,
    navDrawerOpen,
    setNavDrawerOpen,
    unseen: { map: mapUnseen }
  };
}
