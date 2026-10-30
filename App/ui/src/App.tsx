import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAuth, useUser } from "./services/clerkAuth";
import { ConfigPanel } from "./components/ConfigPanel";
import { CreateSpaceModal } from "./components/modals/CreateSpaceModal";
import { DeleteSpaceConfirmModal } from "./components/modals/DeleteSpaceConfirmModal";
import { useToast } from "./components/Toast";
import {
  ResizableDashboardLayout,
  type MobilePane
} from "./components/layout/ResizableDashboardLayout";
import { MobileTabBar } from "./components/layout/MobileTabBar";
import { useMobilePaneFollow } from "./hooks/useMobilePaneFollow";
import { useViewport } from "./hooks/useViewport";
import { CanvasStack } from "./chat/CanvasStack";
import { ChatColumn } from "./chat/ChatColumn";
import { useChatSession } from "./chat/useChatSession";
import { NavigationPanel } from "./components/NavigationPanel";
import { TopBar } from "./components/TopBar";
import { VisualizationPanel } from "./components/VisualizationPanel";
import { ProductTour } from "./components/tour/ProductTour";
import {
  fetchAuditLog,
  fetchInFlightRuns,
  fetchSequenceStatus,
  runSequenceExecution,
  setOnboardingTourSeen,
  stopSequenceExecution,
  updateMySettings,
  type ExecutionFinalResult
} from "./services/api";
import { SequenceDeleteConfirmModal } from "./components/modals/SequenceDeleteConfirmModal";
import { OperationDeleteSuspendModal } from "./components/modals/OperationDeleteSuspendModal";
import { useConsolesNav } from "./hooks/useConsolesNav";
import { useEventsNav } from "./hooks/useEventsNav";
import { ConsoleHost } from "./consoles/ConsoleHost";
import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/notifications/styles.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./consoles/console.css";
import { usePersistedViewRestore } from "./hooks/usePersistedViewRestore";
import uiPersistence from "./services/uiPersistence";
import { useSequenceNav } from "./hooks/useSequenceNav";
import { useSpacesLifecycle } from "./hooks/useSpacesLifecycle";
import { navActivitySequenceIds } from "./state/inFlight";
import { appReducer, initialState } from "./state/reducer";
import { selectors } from "./state/selectors";
import type { BuilderSeed, RunResult } from "./state/builder/types";
import type { ParameterSchema } from "./state/types";
import "./styles.css";
import "./consoles/restore-app.css";

function paramSchemaType(valueType: string): ParameterSchema["type"] {
  switch ((valueType || "").trim().toLowerCase()) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "json";
    default:
      return "string";
  }
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { showToast } = useToast();
  const { signOut } = useAuth();
  const { user } = useUser();
  // Bumped each time a sequence builder session opens (create or edit) so the builder remounts
  // clean for create, or freshly hydrated for edit, without leaking the prior session's state.
  const [sequenceBuilderKey, setSequenceBuilderKey] = useState(0);
  const [builderResult, setBuilderResult] = useState<RunResult | null>(null);
  const [builderSeed, setBuilderSeed] = useState<BuilderSeed | null>(null);
  const [builderEditOperationActive, setBuilderEditOperationActive] = useState(false);
  const [exitEditOperationRequest, setExitEditOperationRequest] = useState(0);
  const [eventEditing, setEventEditing] = useState(false);
  const [consoleEditing, setConsoleEditing] = useState(false);
  const handleEventEditingChange = useCallback((editing: boolean) => {
    setEventEditing(editing);
  }, []);
  const handleConsoleEditingChange = useCallback((editing: boolean) => {
    setConsoleEditing(editing);
  }, []);

  function dismissVisualization() {
    setBuilderResult(null);
    dispatch({ type: "VISUALIZATION_DISMISSED" });
  }

  const { maybeRestoreSequence, maybeRestoreEvent } = usePersistedViewRestore(state, dispatch);

  const spacesLifecycle = useSpacesLifecycle({
    state,
    dispatch,
    showToast,
    signOut,
    dismissVisualization
  });
  const {
    spaces,
    spacesError,
    activeSpaceLabels,
    navStamp,
    bumpSpaceLabelsVersion,
    noAccess,
    showCreateSpaceModal,
    createSpaceRequired
  } = spacesLifecycle;

  const sequenceNav = useSequenceNav({
    state,
    dispatch,
    showToast,
    setBuilderResult,
    maybeRestoreSequence,
    bumpSpaceLabelsVersion,
    navStamp
  });
  const {
    composedSequence,
    composeError,
    refreshComposedSequence,
    sequencePreviewLoading,
    sequenceDelete,
    operationDelete
  } = sequenceNav;

  const eventsNav = useEventsNav({ state, dispatch, maybeRestoreEvent });
  const consolesNav = useConsolesNav({ state, dispatch });
  const [workbenchMode, setWorkbenchMode] = useState<"chat" | "classic">(
    () => state.me?.workbenchMode ?? uiPersistence.getWorkbenchMode() ?? "chat"
  );
  const [tourOpen, setTourOpen] = useState(false);
  const chatMode = workbenchMode === "chat" && !tourOpen;
  // Contents fade out, then the next view fades in. The shared handle waits one frame
  // so its width transition is already armed, then glides between the two column widths.
  const [presentedChat, setPresentedChat] = useState(chatMode);
  const [widthMode, setWidthMode] = useState(chatMode);
  const [viewPhase, setViewPhase] = useState<"idle" | "out">("idle");
  const [columnSliding, setColumnSliding] = useState(false);

  useEffect(() => {
    if (presentedChat === chatMode && widthMode === chatMode) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPresentedChat(chatMode);
      setWidthMode(chatMode);
      setColumnSliding(false);
      return;
    }
    setColumnSliding(true);
    if (presentedChat !== chatMode) setViewPhase("out");
    const frame = window.requestAnimationFrame(() => setWidthMode(chatMode));
    const swap = window.setTimeout(() => setPresentedChat(chatMode), 200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(swap);
    };
  }, [chatMode, presentedChat, widthMode]);

  useEffect(() => {
    if (viewPhase !== "out" || presentedChat !== chatMode) return;
    const frame = window.requestAnimationFrame(() => setViewPhase("idle"));
    return () => window.cancelAnimationFrame(frame);
  }, [viewPhase, presentedChat, chatMode]);

  useEffect(() => {
    if (!columnSliding || widthMode !== chatMode) return;
    const done = window.setTimeout(() => setColumnSliding(false), 450);
    return () => window.clearTimeout(done);
  }, [columnSliding, widthMode, chatMode]);

  useEffect(() => {
    if (!state.me?.workbenchMode) return;
    setWorkbenchMode(state.me.workbenchMode);
    uiPersistence.setWorkbenchMode(state.me.workbenchMode);
  }, [state.me?.workbenchMode]);

  const setWorkbench = useCallback((mode: "chat" | "classic") => {
    setWorkbenchMode(mode);
    uiPersistence.setWorkbenchMode(mode);
    dispatch({ type: "ME_WORKBENCH_UPDATED", mode });
    updateMySettings({ workbenchMode: mode }).catch(() => undefined);
  }, []);

  const chat = useChatSession({
    spaceId: state.spaceId,
    onApplied: () => {
      void sequenceNav.handleNavRefresh();
      eventsNav.reloadEvents();
      consolesNav.reloadConsoles();
    },
    onSpaceCreated: (spaceId) => {
      void spacesLifecycle.reloadSpaces(spaceId);
    }
  });

  const handleSaveTimezone = useCallback((timezone: string) => {
    // Optimistic: reflect the choice immediately, then persist.
    dispatch({ type: "ME_TIMEZONE_UPDATED", timezone });
    updateMySettings({ timezone })
      .then((result) => dispatch({ type: "ME_TIMEZONE_UPDATED", timezone: result.timezone }))
      .catch(() => undefined);
  }, []);

  const handleLogout = useCallback(() => {
    void signOut();
  }, [signOut]);

  // First visit: start the tour once there's a space to show (a brand-new instance asks for
  // one first). Cypress specs drive fresh accounts and would be blocked by the overlay.
  const tourAutoStartedRef = useRef(false);
  useEffect(() => {
    if (tourAutoStartedRef.current) return;
    if (!state.me || state.me.onboardingTourSeen) return;
    if (showCreateSpaceModal || !state.spaceId) return;
    if ((window as { Cypress?: unknown }).Cypress) return;
    tourAutoStartedRef.current = true;
    setTourOpen(true);
  }, [state.me, showCreateSpaceModal, state.spaceId]);

  const handleTourClose = useCallback(() => {
    setTourOpen(false);
    if (state.me?.onboardingTourSeen) return;
    dispatch({ type: "ME_ONBOARDING_TOUR_SEEN", seen: true });
    setOnboardingTourSeen(true).catch(() => undefined);
  }, [state.me?.onboardingTourSeen]);

  const handleStartTour = useCallback(() => {
    // Swap the settings panel for the builder so the workbench step shows what it describes.
    dispatch({ type: "OPEN_BUILDER" });
    setTourOpen(true);
  }, []);

  const showRunButton = useMemo(() => selectors.showRunButton(state), [state]);
  const canRun = useMemo(() => selectors.canRun(state), [state]);
  const consoleEditorId = state.consoles.selectedConsoleId;
  const showVisualization = useMemo(
    () => Boolean(consoleEditorId) || selectors.hasVisualizationContent(state, builderResult),
    [state, builderResult, consoleEditorId]
  );
  const showConfig = useMemo(
    () => (consoleEditorId ? false : selectors.hasConfigContent(state)),
    [state, consoleEditorId]
  );
  const workbenchActive =
    state.view.rightPanelMode === "builder" &&
    !state.nav.selectedSequenceId &&
    !state.events.selectedEventId &&
    !state.consoles.selectedConsoleId &&
    !state.createEvent &&
    !state.createSequence &&
    !state.spacePanelOpen &&
    !state.editor.selectedElement;

  const viewport = useViewport();
  const compactShell = viewport.mode !== "desktop";
  const layoutChatMode = viewport.mode === "desktop" ? widthMode : presentedChat;
  const panes = useMobilePaneFollow({
    mode: viewport.mode,
    state,
    builderResult,
    builderSeed,
    chatMode
  });
  const { setMobilePane, setNavDrawerOpen } = panes;
  const handleTourShowPane = useCallback(
    (pane: MobilePane | null) => {
      if (viewport.mode === "phone" && pane) setMobilePane(pane);
      if (viewport.mode === "tablet") setNavDrawerOpen(pane === "menu");
    },
    [viewport.mode, setMobilePane, setNavDrawerOpen]
  );

  // The nav only shows sequences whose attributive_label was created or imported
  // in the active space. Non-sequence rows (operations/system) are not nav items
  // and pass through untouched.
  const navSequences = useMemo(() => {
    const allowed = new Set(activeSpaceLabels);
    return state.nav.sequences.filter(
      (sequence) => sequence.kind !== "sequence" || allowed.has(sequence.attributiveLabel)
    );
  }, [state.nav.sequences, activeSpaceLabels]);

  // Clicking a STEP node in the sequence design graph opens it in the builder for editing.
  // (The inspect panel is read-only, so node clicks route through the same seed flow as
  // the result graph.) We resolve the attributive_label
  // from the loaded step-flow definition before dispatching, since OPEN_BUILDER clears it.
  const handleVisualNodeClick = useCallback(
    (nodeId: string) => {
      const node = state.sequence.definition?.stepGraph.nodes.find((n) => n.id === nodeId);
      const attributiveLabel = node?.attributive_label;
      if (typeof attributiveLabel !== "string" || !attributiveLabel.trim()) return;
      setBuilderResult(null);
      dispatch({ type: "OPEN_BUILDER" });
      setBuilderSeed({
        kind: "stepNode",
        attributiveLabel: attributiveLabel.trim(),
        nonce: Date.now()
      });
    },
    [state.sequence.definition]
  );
  // Clicking a POINTS_TO relationship in the sequence design graph opens it in the builder for
  // editing. The builder can't display a relationship without its supporting start/end nodes, so
  // we hand it the relationship's start node attributive_label and graph id; the builder loads the
  // full `(start)-[rel]->(end)` path into the update STEP flow. We resolve the start node from the
  // loaded step-flow definition before dispatching, since OPEN_BUILDER clears it.
  const handleVisualRelationshipClick = useCallback(
    (relId: string) => {
      const definition = state.sequence.definition;
      const rel = definition?.stepGraph.relationships.find((r) => r.id === relId);
      const startNode = rel
        ? definition?.stepGraph.nodes.find((n) => n.id === rel.source)
        : undefined;
      const startAttributiveLabel = startNode?.attributive_label;
      if (typeof startAttributiveLabel !== "string" || !startAttributiveLabel.trim()) return;
      setBuilderResult(null);
      dispatch({ type: "OPEN_BUILDER" });
      setBuilderSeed({
        kind: "stepRelationship",
        startAttributiveLabel: startAttributiveLabel.trim(),
        relationshipId: relId,
        nonce: Date.now()
      });
    },
    [state.sequence.definition]
  );

  // Clicking a STEP node in a displayed sequence result loads it into the builder. We resolve the
  // node's attributive_label from the result graph and open the builder (which clears the sequence
  // selection but leaves the result graph visible so other nodes stay clickable), then hand the
  // builder a seed; the builder decides between the update STEP flow (custom-endpoint node) and the
  // locked edit-operation view (operation-backed node) once it resolves the underlying STEP row.
  const handleSequenceResultNodeClick = useCallback(
    (nodeId: string) => {
      const node = builderResult?.graph?.nodes.find((n) => n.element_id === nodeId);
      if (!node || !node.labels.includes("STEP")) return;
      const attributiveLabel = node.properties?.attributive_label;
      if (typeof attributiveLabel !== "string" || !attributiveLabel.trim()) return;
      dispatch({ type: "OPEN_BUILDER" });
      setBuilderSeed({
        kind: "stepNode",
        attributiveLabel: attributiveLabel.trim(),
        nonce: Date.now()
      });
    },
    [builderResult]
  );

  // Clicking a POINTS_TO relationship in a displayed sequence *result* graph opens it for editing,
  // mirroring the design-graph relationship click. The result graph carries Neo4j element ids, so
  // we resolve the start STEP node by element id (for its attributive_label) and use the
  // relationship's stable `id` property (matching the rel_id the builder resolves outgoing edges
  // by). Leaves the result graph visible so other elements stay clickable.
  const handleSequenceResultRelationshipClick = useCallback(
    (relId: string) => {
      const graph = builderResult?.graph;
      const rel = graph?.relationships.find((r) => r.element_id === relId);
      if (!rel) return;
      const startNode = graph?.nodes.find((n) => n.element_id === rel.start);
      if (!startNode || !startNode.labels.includes("STEP")) return;
      const startAttributiveLabel = startNode.properties?.attributive_label;
      const stableRelId = rel.properties?.id;
      if (typeof startAttributiveLabel !== "string" || !startAttributiveLabel.trim()) return;
      if (typeof stableRelId !== "string" || !stableRelId.trim()) return;
      dispatch({ type: "OPEN_BUILDER" });
      setBuilderSeed({
        kind: "stepRelationship",
        startAttributiveLabel: startAttributiveLabel.trim(),
        relationshipId: stableRelId.trim(),
        nonce: Date.now()
      });
    },
    [builderResult]
  );

  // Open a sequence in the builder for editing. Multi-step rows hydrate the sequence
  // builder_config. One-step rows are synthetic wraps — the pencil opens the wrapped
  // operation the same way a visualizer STEP click does.
  function handleEditSequence(sequenceId: string) {
    const target = state.nav.sequences.find((sequence) => sequence.id === sequenceId);
    if (!target) return;
    if (target.singleStep) {
      const attributiveLabel = target.attributiveLabel.trim();
      if (!attributiveLabel) {
        showToast("This sequence's entry STEP is missing, so it can't be edited.", "error");
        return;
      }
      dismissVisualization();
      dispatch({ type: "OPEN_BUILDER" });
      setSequenceBuilderKey((key) => key + 1);
      setBuilderSeed({
        kind: "stepNode",
        attributiveLabel,
        nonce: Date.now()
      });
      return;
    }
    dismissVisualization();
    dispatch({ type: "CREATE_SEQUENCE_OPENED" });
    setSequenceBuilderKey((key) => key + 1);
    setBuilderSeed({
      kind: "editSequence",
      sequenceId,
      name: target.label,
      groupTitle: target.groupTitle ?? "",
      description: target.description ?? "",
      nonce: Date.now()
    });
  }

  const loadAuditLog = useCallback(() => {
    if (!state.spaceId) return;
    const spaceId = state.spaceId;
    dispatch({ type: "AUDIT_LOG_LOAD_STARTED" });
    fetchAuditLog(spaceId)
      .then((entries) => dispatch({ type: "AUDIT_LOG_LOAD_SUCCEEDED", entries }))
      .catch((error: unknown) =>
        dispatch({
          type: "AUDIT_LOG_LOAD_FAILED",
          error: error instanceof Error ? error.message : "Unable to load audit log"
        })
      );
  }, [state.spaceId]);

  const lastPolledResultRef = useRef<string | null>(null);

  const selectedInFlight = useMemo(
    () => state.inFlight.find((run) => run.sequence_id === state.nav.selectedSequenceId) ?? null,
    [state.inFlight, state.nav.selectedSequenceId]
  );

  const applyFinishedResult = useCallback(
    (
      result: { resolved?: Record<string, unknown>; final_result?: ExecutionFinalResult | null },
      toast: boolean
    ) => {
      dispatch({ type: "RESPONSE_VALUES_UPDATED", values: result.resolved ?? {} });
      const final = result.final_result ?? null;
      if (final && final.kind === "graph") {
        setBuilderResult({
          kind: "graph",
          columns: final.columns,
          rows: final.rows,
          graph: final.graph
        });
      } else if (final && final.kind === "table") {
        setBuilderResult({ kind: "table", columns: final.columns, rows: final.rows });
      } else if (final && final.kind === "response") {
        setBuilderResult({
          kind: "response",
          response: final.response,
          status: final.status,
          ok: final.ok,
          error: final.error
        });
      } else {
        setBuilderResult(null);
      }
      dispatch({ type: "RUN_SUCCEEDED", runId: `${Date.now()}`, result: null });
      if (!toast) return;
      const endpointFailed = final?.kind === "response" && final.ok === false;
      if (endpointFailed) {
        showToast("execution finished with an endpoint error", "error");
      } else {
        showToast("successful execution");
      }
    },
    [showToast]
  );

  const trackedRunRef = useRef<{ sequenceId: string; stateId: string } | null>(null);

  useEffect(() => {
    if (!state.spaceId) return;
    let cancelled = false;
    const spaceId = state.spaceId;
    const selectedSequenceId = state.nav.selectedSequenceId;
    async function tick() {
      try {
        const runs = await fetchInFlightRuns(spaceId);
        if (cancelled) return;
        dispatch({ type: "IN_FLIGHT_UPDATED", runs });
        const mine = selectedSequenceId
          ? runs.find((run) => run.sequence_id === selectedSequenceId)
          : undefined;
        if (mine && (mine.status === "waiting" || mine.status === "active")) {
          trackedRunRef.current = { sequenceId: mine.sequence_id, stateId: mine.state_id };
          return;
        }
        if (mine) {
          trackedRunRef.current = null;
          return;
        }
        const tracked = trackedRunRef.current;
        if (!tracked || tracked.sequenceId !== selectedSequenceId) {
          trackedRunRef.current = null;
          return;
        }
        const status = await fetchSequenceStatus(tracked.stateId);
        if (cancelled) return;
        trackedRunRef.current = null;
        const key = `${tracked.stateId}:${status.status}`;
        if (lastPolledResultRef.current === key) return;
        lastPolledResultRef.current = key;
        if (status.status === "inactive" && "final_result" in status) {
          applyFinishedResult(status, true);
        } else if (status.status === "cancelled") {
          dispatch({ type: "RUN_SUCCEEDED", runId: `${Date.now()}`, result: null });
        }
      } catch {
        /* polling must not surface as a run failure */
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [state.spaceId, state.nav.selectedSequenceId, applyFinishedResult]);

  async function handleRun() {
    if (!state.nav.selectedSequenceId || !state.spaceId || !canRun) return;
    // A suspended sequence (a SCHEMA change invalidated one of its INSTANCE steps) cannot run
    // until the step is re-saved. The backend rejects it too, but block early with a clear reason.
    const selectedSequence = navSequences.find((s) => s.id === state.nav.selectedSequenceId);
    if (selectedSequence?.suspended) {
      dispatch({
        type: "RUN_FAILED",
        error:
          "This sequence is suspended: a schema change invalidated one of its INSTANCE steps. " +
          "Re-save the affected step to match the new schema pattern, then try again."
      });
      return;
    }
    const inflight = selectedInFlight;
    if (inflight && (inflight.status === "waiting" || inflight.status === "active")) {
      return;
    }
    const isResume = state.run.awaitingParams || inflight?.status === "pending";
    // A resume continues a paused (pending) run with the inputs gathered so far; a fresh run
    // starts from a clean slate. On a fresh run we clear the progressively-revealed inputs and
    // resolved values and send no params, so the executor pauses at the first step that needs
    // input and we reveal each step's parameters as it's reached. Fresh runs also re-compose so
    // STEP payload edits (Wait kind, bindings) are in the package, not a stale state row.
    if (!isResume) {
      dispatch({ type: "RUN_INPUTS_RESET" });
    }
    dispatch({ type: "RUN_REQUESTED" });
    try {
      let runStateId = (isResume && inflight?.state_id) || composedSequence?.state_id;
      if (!isResume) {
        const composed = await refreshComposedSequence();
        runStateId = composed?.state_id || runStateId;
      }
      if (!runStateId) {
        dispatch({
          type: "RUN_FAILED",
          error: composeError
            ? `Sequence failed to compose: ${composeError}`
            : "Sequence is still composing; try again."
        });
        return;
      }
      const result = await runSequenceExecution(
        state.spaceId,
        runStateId,
        isResume ? state.params.values : {}
      );

      if (result.status === "error") {
        dispatch({ type: "RUN_FAILED", error: result.message });
        return;
      }

      if (result.status === "waiting" || result.status === "cancelling") {
        dispatch({ type: "RUN_SUCCEEDED", runId: `${Date.now()}`, result: null });
        try {
          const runs = await fetchInFlightRuns(state.spaceId);
          dispatch({ type: "IN_FLIGHT_UPDATED", runs });
        } catch {
          /* nav poll will catch up */
        }
        return;
      }

      if (result.status === "cancelled") {
        dispatch({ type: "RUN_SUCCEEDED", runId: `${Date.now()}`, result: null });
        showToast("sequence stopped");
        return;
      }

      if (result.status === "pending") {
        // Human-in-the-loop: the executor paused at a step that needs input, so reveal all of
        // that step's fields (a required-but-empty one triggers the pause, but optional fields
        // are shown too so the operator can review/override them). On a resume we merge them with
        // the inputs already shown (steps reached earlier); on a fresh run we start from an empty
        // schema so only the newly-reached step's inputs appear. The design graph stays in view.
        dispatch({ type: "RESPONSE_VALUES_UPDATED", values: result.resolved });
        const pendingSchema: ParameterSchema[] = result.parameters.map((parameter) => ({
          name: parameter.name,
          required: Boolean(parameter.is_required),
          type: paramSchemaType(parameter.value_type),
          valueType: parameter.value_type,
          options: parameter.options,
          minChoices: parameter.min_choices,
          maxChoices: parameter.max_choices
        }));
        const mergedSchema = isResume ? [...state.params.schema] : [];
        for (const parameter of pendingSchema) {
          if (!mergedSchema.some((existing) => existing.name === parameter.name)) {
            mergedSchema.push(parameter);
          }
        }
        const defaults: Record<string, unknown> = {};
        for (const parameter of result.parameters) {
          if (parameter.default_value !== undefined && parameter.default_value !== null) {
            defaults[parameter.name] = parameter.default_value;
          }
        }
        dispatch({ type: "SEQUENCE_PARAMS_RESOLVED", schema: mergedSchema, defaults });
        dispatch({
          type: "RUN_SUCCEEDED",
          runId: `${Date.now()}`,
          result: null,
          awaitingParams: true
        });
        try {
          const runs = await fetchInFlightRuns(state.spaceId);
          dispatch({ type: "IN_FLIGHT_UPDATED", runs });
        } catch {
          /* nav poll will catch up */
        }
        return;
      }

      applyFinishedResult(result, true);
      try {
        const runs = await fetchInFlightRuns(state.spaceId);
        dispatch({ type: "IN_FLIGHT_UPDATED", runs });
      } catch {
        /* nav poll will catch up */
      }
    } catch (error: unknown) {
      dispatch({
        type: "RUN_FAILED",
        error: error instanceof Error ? error.message : "Run failed"
      });
    }
  }

  async function handleStop() {
    if (!state.spaceId || !state.nav.selectedSequenceId) return;
    const result = await stopSequenceExecution(state.spaceId, {
      sequenceId: state.nav.selectedSequenceId,
      stateId: selectedInFlight?.state_id
    });
    try {
      const runs = await fetchInFlightRuns(state.spaceId);
      dispatch({ type: "IN_FLIGHT_UPDATED", runs });
    } catch {
      /* nav poll will catch up */
    }
    if (result.status === "error") {
      showToast(result.message, "error");
      return;
    }
    trackedRunRef.current = null;
    dispatch({ type: "RUN_SUCCEEDED", runId: `${Date.now()}`, result: null });
    showToast("sequence stopped");
  }

  if (noAccess) {
    return (
      <div className="appRoot noAccessRoot">
        <div className="noAccessCard">
          <h1>no access</h1>
          <p>
            This account is not authorized for access to any spaces within this instance.
          </p>
          <p className="muted">You'll be signed out automatically.</p>
          <button type="button" className="btnPrimary" onClick={handleLogout}>
            Log out now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="appRoot">
      {showCreateSpaceModal ? (
        <CreateSpaceModal
          required={createSpaceRequired}
          existingNames={spaces.flatMap((space) => [space.id, space.label])}
          saving={spacesLifecycle.creatingSpace}
          error={spacesLifecycle.createSpaceError}
          onCancel={createSpaceRequired ? undefined : spacesLifecycle.closeCreateSpaceModal}
          onSubmit={spacesLifecycle.handleCreateSpace}
        />
      ) : null}
      {spacesLifecycle.deleteSpaceModal ? (
        <DeleteSpaceConfirmModal
          spaceName={spacesLifecycle.deleteSpaceModal.spaceName}
          saving={spacesLifecycle.deletingSpace}
          error={spacesLifecycle.deleteSpaceError}
          onCancel={spacesLifecycle.closeDeleteSpaceModal}
          onConfirm={spacesLifecycle.handleDeleteSpaceConfirm}
        />
      ) : null}
      {sequenceDelete ? (
        <SequenceDeleteConfirmModal
          sequenceLabel={sequenceDelete.label}
          preview={sequenceDelete.preview}
          busy={sequenceNav.deletingSequence}
          error={sequenceNav.sequenceDeleteError}
          onCancel={sequenceNav.cancelSequenceDelete}
          onConfirm={sequenceNav.handleConfirmDeleteSequence}
        />
      ) : null}
      {operationDelete ? (
        <OperationDeleteSuspendModal
          sequenceLabel={operationDelete.label}
          preview={operationDelete.preview}
          busy={sequenceNav.deletingSequence}
          error={sequenceNav.sequenceDeleteError}
          onCancel={sequenceNav.cancelSequenceDelete}
          onConfirm={sequenceNav.handleConfirmDeleteOperation}
        />
      ) : null}
      <TopBar
        compact={compactShell}
        spaces={spaces}
        selectedSpaceId={state.spaceId}
        onSelectSpace={(spaceId) => dispatch({ type: "SPACE_SELECTED", spaceId })}
        onCreateSpace={spacesLifecycle.openCreateSpaceModal}
        canCreateSpace={Boolean(state.me?.canCreateSpaces)}
        spaceConfigActive={state.view.rightPanelMode === "space"}
        onOpenSpaceConfig={() => {
          dismissVisualization();
          // Phone chat has no settings column, so open them on the classic workbench pane.
          if (chatMode && viewport.mode === "phone") setWorkbench("classic");
          dispatch({ type: "SPACE_PANEL_OPENED" });
        }}
        onToggleNav={
          !chatMode && viewport.mode === "tablet"
            ? () => panes.setNavDrawerOpen((open) => !open)
            : undefined
        }
        navOpen={panes.navDrawerOpen}
        mode={chatMode ? "chat" : "classic"}
        onOpenChat={() => {
          if (!chatMode) setWorkbench("chat");
        }}
        onOpenWorkbench={() => {
          if (chatMode) setWorkbench("classic");
        }}
        showRunButton={chatMode ? false : showRunButton}
        canRun={canRun}
        running={state.run.status === "running"}
        onRun={handleRun}
        inFlightStatus={selectedInFlight?.status ?? null}
        awaitingParams={state.run.awaitingParams}
        onStop={handleStop}
      />

      {spacesError ? <div className="appError">Space load error: {spacesError}</div> : null}

      <ResizableDashboardLayout
        showVisualization={presentedChat ? true : showVisualization}
        showConfig={
          presentedChat
            ? viewport.mode !== "phone" && state.view.rightPanelMode === "space"
            : showConfig
        }
        mode={viewport.mode}
        chatMode={layoutChatMode}
        contentHidden={viewPhase === "out"}
        columnSliding={columnSliding}
        mobilePane={panes.mobilePane}
        navDrawerOpen={panes.navDrawerOpen}
        onCloseNavDrawer={() => panes.setNavDrawerOpen(false)}
        navigation={
          presentedChat ? (
            <ChatColumn
              threads={chat.threads}
              threadId={chat.threadId}
              messages={chat.messages}
              draft={chat.draft}
              queued={chat.queued}
              streaming={chat.streaming}
              batchBusy={chat.batchBusy}
              error={chat.error}
              selectedMessageId={chat.insight?.kind === "reasoning" ? chat.insight.messageId : null}
              onSelectMessage={chat.selectMessage}
              onSelectRead={chat.selectRead}
              onDraft={chat.setDraft}
              onSend={() => void chat.send(chat.draft)}
              onOpenThread={(id) => void chat.openThread(id)}
              onNewThread={chat.newThread}
              onAccept={() => void chat.accept()}
              onReject={() => void chat.reject()}
              onClearQueue={() => chat.setQueued(null)}
            />
          ) : (
          <NavigationPanel
            sequences={navSequences}
            groups={state.nav.groups}
            selectedSequenceId={state.nav.selectedSequenceId}
            loading={state.nav.loading}
            error={state.nav.error}
            onSelectSequence={(sequenceId) => {
              if (sequenceId === state.nav.selectedSequenceId) return;
              setBuilderResult(null);
              dispatch({ type: "SEQUENCE_SELECTED", sequenceId });
            }}
            onCreateSequence={() => {
              dismissVisualization();
              dispatch({ type: "CREATE_SEQUENCE_OPENED" });
              setBuilderSeed(null);
              setSequenceBuilderKey((key) => key + 1);
            }}
            onEditSequence={handleEditSequence}
            onDeleteSequence={sequenceNav.handleDeleteSequence}
            onReorderSequences={sequenceNav.handleReorderSequences}
            onReorderGroups={sequenceNav.handleReorderGroups}
            onAddGroup={sequenceNav.handleAddGroup}
            onDeleteGroup={sequenceNav.handleDeleteGroup}
            events={state.events.items}
            selectedEventId={state.events.selectedEventId}
            eventsLoading={state.events.loading}
            eventsError={state.events.error}
            onSelectEvent={(eventId) => dispatch({ type: "EVENT_SELECTED", eventId })}
            onEditEvent={(eventId) => dispatch({ type: "EVENT_SELECTED", eventId, edit: true })}
            onCreateEvent={() => {
              dismissVisualization();
              dispatch({ type: "CREATE_EVENT_OPENED" });
            }}
            onDeleteEvent={eventsNav.handleDeleteEvent}
            eventGroups={state.events.groups}
            onReorderEvents={eventsNav.handleReorderEvents}
            onReorderEventGroups={eventsNav.handleReorderEventGroups}
            onAddEventGroup={eventsNav.handleAddEventGroup}
            onDeleteEventGroup={eventsNav.handleDeleteEventGroup}
            eventEditing={eventEditing}
            consoleEditing={consoleEditing}
            consoles={state.consoles.items}
            consoleGroups={state.consoles.groups}
            selectedConsoleId={state.consoles.selectedConsoleId}
            consolesLoading={state.consoles.loading}
            consolesError={state.consoles.error}
            onSelectConsole={(consoleId) => dispatch({ type: "CONSOLE_SELECTED", consoleId })}
            onEditConsole={(consoleId) =>
              dispatch({ type: "CONSOLE_SELECTED", consoleId, edit: true })
            }
            onCreateConsole={() => {
              void consolesNav.handleCreateConsole();
            }}
            onDeleteConsole={(consoleId) => {
              void consolesNav.handleDeleteConsole(consoleId);
            }}
            onReorderConsoles={consolesNav.handleReorderConsoles}
            onReorderConsoleGroups={consolesNav.handleReorderConsoleGroups}
            onAddConsoleGroup={consolesNav.handleAddConsoleGroup}
            onDeleteConsoleGroup={consolesNav.handleDeleteConsoleGroup}
            userName={user?.fullName ?? user?.firstName ?? null}
            userEmail={state.me?.email ?? user?.primaryEmailAddress?.emailAddress ?? null}
            userTimezone={state.me?.timezone ?? null}
            onSaveTimezone={handleSaveTimezone}
            onLogout={handleLogout}
            isSuperadmin={Boolean(state.me?.isSuperadmin)}
            inFlightSequenceIds={navActivitySequenceIds(state.inFlight)}
            workbenchActive={workbenchActive}
            onOpenWorkbench={() => {
              if (viewport.mode === "phone") panes.setMobilePane("workbench");
              if (viewport.mode === "tablet") panes.setNavDrawerOpen(false);
              if (workbenchActive) return;
              setBuilderResult(null);
              setBuilderSeed(null);
              dispatch({ type: "OPEN_BUILDER" });
            }}
          />
          )
        }
        visualization={
          presentedChat && state.spaceId ? (
            <CanvasStack
              spaceId={state.spaceId}
              items={chat.stack}
              activeId={chat.activeStackId}
              sequences={navSequences}
              events={state.events.items}
              batchBusy={chat.batchBusy}
              insight={chat.insightView}
              onCloseInsight={chat.closeInsight}
              onSelect={chat.selectStack}
              onAccept={() => void chat.accept()}
              onReject={() => void chat.reject()}
              onRecord={chat.recordStackItem}
              onPatch={chat.patchStackItem}
            />
          ) : consoleEditorId && state.spaceId ? (
            <ConsoleHost
              spaceId={state.spaceId}
              consoleId={consoleEditorId}
              mode="edit"
              editNonce={state.consoles.editNonce}
              onEditingChange={handleConsoleEditingChange}
              onRenamed={(name) =>
                dispatch({ type: "CONSOLE_RENAMED", consoleId: consoleEditorId, name })
              }
              sequences={navSequences}
              events={state.events.items}
              externalRefreshToken={0}
            />
          ) : (
            <VisualizationPanel
              state={state}
              builderResult={builderResult}
              previewLoading={sequencePreviewLoading}
              onClickNode={handleVisualNodeClick}
              onClickRelationship={handleVisualRelationshipClick}
              onResultNodeClick={handleSequenceResultNodeClick}
              onResultRelationshipClick={handleSequenceResultRelationshipClick}
            />
          )
        }
        config={
          <ConfigPanel
            state={state}
            onParamChange={(name, value) => dispatch({ type: "PARAM_CHANGED", name, value })}
            onParamValidityUpdate={(validity) =>
              dispatch({ type: "PARAM_VALIDITY_UPDATED", validity })
            }
            onCloseInspect={() => dispatch({ type: "INSPECT_CLOSED" })}
            onBuilderResult={setBuilderResult}
            onSequenceCreated={sequenceNav.handleSequenceCreated}
            onNavRefresh={sequenceNav.handleNavRefresh}
            builderSeed={builderSeed}
            onBuilderSeedConsumed={() => setBuilderSeed(null)}
            onEditOperationActiveChange={setBuilderEditOperationActive}
            exitEditOperationRequest={exitEditOperationRequest}
            builderKey={sequenceBuilderKey}
            onEventSaved={eventsNav.handleEventSaved}
            onEventDeleted={eventsNav.handleEventDeleted}
            onEventEditingChange={handleEventEditingChange}
            spaces={spaces}
            onSpaceSaved={spacesLifecycle.handleUpdateSpace}
            savingSpace={spacesLifecycle.savingSpaceEdit}
            spaceSaveError={spacesLifecycle.editSpaceError}
            onDeleteSpace={spacesLifecycle.openDeleteSpaceModal}
            onLoadAuditLog={loadAuditLog}
            onSpacePanelClose={() => dispatch({ type: "SPACE_PANEL_CLOSED" })}
            onStartTour={handleStartTour}
            executionPackage={composedSequence?.package ?? null}
            composeError={composeError}
          />
        }
      />
      {viewport.mode === "phone" ? (
        <MobileTabBar
          active={panes.mobilePane}
          onChange={panes.setMobilePane}
          unseen={panes.unseen}
          chatMode={chatMode}
        />
      ) : null}
      <ProductTour
        open={tourOpen}
        onClose={handleTourClose}
        mode={viewport.mode}
        onShowPane={handleTourShowPane}
      />
    </div>
  );
}
