import { useCallback, useMemo, useReducer, useState } from "react";
import { useAuth, useUser } from "./services/clerkAuth";
import { ConfigPanel } from "./components/ConfigPanel";
import { CreateSpaceModal } from "./components/modals/CreateSpaceModal";
import { DeleteSpaceConfirmModal } from "./components/modals/DeleteSpaceConfirmModal";
import { useToast } from "./components/Toast";
import { ResizableDashboardLayout } from "./components/layout/ResizableDashboardLayout";
import { NavigationPanel } from "./components/NavigationPanel";
import { TopBar } from "./components/TopBar";
import { VisualizationPanel } from "./components/VisualizationPanel";
import { fetchAuditLog, runSequenceExecution, updateMySettings } from "./services/api";
import { SequenceDeleteConfirmModal } from "./components/modals/SequenceDeleteConfirmModal";
import { OperationDeleteSuspendModal } from "./components/modals/OperationDeleteSuspendModal";
import { useEventsNav } from "./hooks/useEventsNav";
import { usePersistedViewRestore } from "./hooks/usePersistedViewRestore";
import { useSequenceNav } from "./hooks/useSequenceNav";
import { useSpacesLifecycle } from "./hooks/useSpacesLifecycle";
import { appReducer, initialState } from "./state/reducer";
import { selectors } from "./state/selectors";
import type { BuilderSeed, RunResult } from "./state/builder/types";
import type { ParameterSchema } from "./state/types";
import "./styles.css";

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
    hideEmptySequenceGroups,
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
    bumpSpaceLabelsVersion
  });
  const { composedSequence, composeError, sequencePreviewLoading, sequenceDelete, operationDelete } =
    sequenceNav;

  const eventsNav = useEventsNav({ state, dispatch, maybeRestoreEvent });

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

  const showRunButton = useMemo(() => selectors.showRunButton(state), [state]);
  const canRun = useMemo(() => selectors.canRun(state), [state]);
  const showVisualization = useMemo(
    () => selectors.hasVisualizationContent(state, builderResult),
    [state, builderResult]
  );
  const showConfig = useMemo(() => selectors.hasConfigContent(state), [state]);

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
    if (!composedSequence) {
      // Distinguish a compose that failed (surface the server's reason) from one
      // that simply hasn't finished yet.
      dispatch({
        type: "RUN_FAILED",
        error: composeError
          ? `Sequence failed to compose: ${composeError}`
          : "Sequence is still composing; try again."
      });
      return;
    }
    // A resume continues a paused (pending) run with the inputs gathered so far; a fresh run
    // starts from a clean slate. On a fresh run we clear the progressively-revealed inputs and
    // resolved values and send no params, so the executor pauses at the first step that needs
    // input and we reveal each step's parameters as it's reached.
    const isResume = state.run.awaitingParams;
    if (!isResume) {
      dispatch({ type: "RUN_INPUTS_RESET" });
    }
    dispatch({ type: "RUN_REQUESTED" });
    try {
      const result = await runSequenceExecution(
        state.spaceId,
        composedSequence.state_id,
        isResume ? state.params.values : {}
      );

      if (result.status === "error") {
        dispatch({ type: "RUN_FAILED", error: result.message });
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
        return;
      }

      // Finished: surface resolved response parameters in the params panel. Query-step
      // finals (graph or table) go in the results panel — a vector-search read returns
      // the node plus a score, and if the driver only hydrated property maps the
      // classifier still emits a table we must not drop. Custom-endpoint JSON stays a
      // response view. Anything else keeps the sequence design graph.
      dispatch({ type: "RESPONSE_VALUES_UPDATED", values: result.resolved });
      const final = result.final_result;
      if (final && final.kind === "graph") {
        setBuilderResult({ kind: "graph", columns: final.columns, rows: final.rows, graph: final.graph });
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
      const endpointFailed = final?.kind === "response" && final.ok === false;
      if (endpointFailed) {
        showToast("execution finished with an endpoint error", "error");
      } else {
        showToast("successful execution");
      }
    } catch (error: unknown) {
      dispatch({
        type: "RUN_FAILED",
        error: error instanceof Error ? error.message : "Run failed"
      });
    }
  }

  if (noAccess) {
    return (
      <div className="appRoot noAccessRoot">
        <div className="noAccessCard">
          <h1>No access</h1>
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
        showBackToBuilder={
          state.createSequence ||
          state.view.rightPanelMode === "params" ||
          state.view.rightPanelMode === "event" ||
          state.view.rightPanelMode === "space" ||
          state.view.rightPanelMode === "localLlms" ||
          builderEditOperationActive
        }
        onBackToBuilder={() => {
          setBuilderResult(null);
          if (builderEditOperationActive) {
            setExitEditOperationRequest((request) => request + 1);
          } else {
            dispatch({ type: "OPEN_BUILDER" });
          }
        }}
        showRunButton={showRunButton}
        canRun={canRun}
        running={state.run.status === "running"}
        onRun={handleRun}
      />

      {spacesError ? <div className="appError">Space load error: {spacesError}</div> : null}

      <ResizableDashboardLayout
        showVisualization={showVisualization}
        showConfig={showConfig}
        navigation={
          <NavigationPanel
            spaces={spaces}
            selectedSpaceId={state.spaceId}
            onSelectSpace={(spaceId) => dispatch({ type: "SPACE_SELECTED", spaceId })}
            onCreateSpace={spacesLifecycle.openCreateSpaceModal}
            canCreateSpace={Boolean(state.me?.canCreateSpaces)}
            spaceConfigActive={state.view.rightPanelMode === "space"}
            onOpenSpaceConfig={() => {
              dismissVisualization();
              dispatch({ type: "SPACE_PANEL_OPENED" });
            }}
            sequences={navSequences}
            groups={state.nav.groups}
            hideEmptySequenceGroups={hideEmptySequenceGroups}
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
            onCreateEvent={() => {
              dismissVisualization();
              dispatch({ type: "CREATE_EVENT_OPENED" });
            }}
            onDeleteEvent={eventsNav.handleDeleteEvent}
            userName={user?.fullName ?? user?.firstName ?? null}
            userEmail={state.me?.email ?? user?.primaryEmailAddress?.emailAddress ?? null}
            userTimezone={state.me?.timezone ?? null}
            onSaveTimezone={handleSaveTimezone}
            onLogout={handleLogout}
          />
        }
        visualization={
          <VisualizationPanel
            state={state}
            builderResult={builderResult}
            previewLoading={sequencePreviewLoading}
            onClickNode={handleVisualNodeClick}
            onClickRelationship={handleVisualRelationshipClick}
            onResultNodeClick={handleSequenceResultNodeClick}
            onResultRelationshipClick={handleSequenceResultRelationshipClick}
          />
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
            onEventCancel={() => dispatch({ type: "EVENT_DESELECTED" })}
            spaces={spaces}
            onSpaceSaved={spacesLifecycle.handleUpdateSpace}
            savingSpace={spacesLifecycle.savingSpaceEdit}
            spaceSaveError={spacesLifecycle.editSpaceError}
            onDeleteSpace={spacesLifecycle.openDeleteSpaceModal}
            onLoadAuditLog={loadAuditLog}
            onSpacePanelClose={() => dispatch({ type: "SPACE_PANEL_CLOSED" })}
            onLocalLlmsPanelClose={() => dispatch({ type: "LOCAL_LLMS_PANEL_CLOSED" })}
            executionPackage={composedSequence?.package ?? null}
            composeError={composeError}
          />
        }
      />
    </div>
  );
}
