import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import connector from "../../services/connector";
import { fetchSpaceRecord } from "../../services/api";
import regexValidator from "../../services/regexValidator";
import {
  createResponseToRunResult,
  runCreate,
  saveQueryOperation,
  saveSequencePackage,
  updateQueryOperation,
  updateSequencePackage
} from "../../services/execute";
import { QueryRunActions } from "./QueryRunActions";
import { runButtonLabel } from "./runButtonLabels";
import { regenerateQueryIdAfterOperationSave } from "../../state/builder/afterOperationSave";
import { BuilderProvider, useBuilder } from "../../state/builder/BuilderContext";
import { builderSelectors } from "../../state/builder/selectors";
import { sequenceEntryPointWarnings } from "@pona-flow/authoring";
import type { BuilderSeed, RunResult } from "../../state/builder/types";
import {
  loadStepNodeIntoQuery,
  loadStepRelationshipIntoQuery
} from "../../state/builder/stepEntityLoad";
import { isHydratableBuilderConfig } from "@pona-flow/authoring";
import { AdvancedOptions } from "./AdvancedOptions";
import { LivePreview } from "./LivePreview";
import {
  CREATE_NEW_GROUP,
  CreateOperationModal,
  type CreateOperationFormValues
} from "./modals/CreateOperationModal";
import { Picker } from "./Picker";
import { QueryCard } from "./QueryCard";
import { useToast } from "../Toast";
import "./builder.css";

function loadSavedQueries(dispatch: ReturnType<typeof useBuilder>["dispatch"]) {
  connector
    .fetchSavedQueries()
    .then((rows) => {
      dispatch({
        type: "SET_SAVED_QUERIES",
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          operation: r.operation,
          kind: r.kind,
          runtimeEnabled: Boolean(r.runtime_enabled),
          suspended: Boolean(r.suspended)
        }))
      });
    })
    .catch(() => undefined);
}

function refreshSpaceLabels(
  spaceId: string,
  dispatch: ReturnType<typeof useBuilder>["dispatch"]
) {
  connector
    .fetchSpaceLabels(spaceId)
    .then((labels) => dispatch({ type: "SET_SPACE_LABELS", labels }))
    .catch(() => undefined);
}

// Bottom actions while editing a saved operation (loaded from a query-backed STEP): a single
// "Save operation" button that recompiles the edited query and updates the catalog row in place.
function EditOperationActions({ onNavRefresh }: { onNavRefresh?: () => void }) {
  const { state, dispatch } = useBuilder();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const canSave = builderSelectors.canSaveOperation(state);

  async function onSave() {
    setBusy(true);
    dispatch({ type: "SET_STATUS", message: "Saving operation…", kind: "info" });
    try {
      await updateQueryOperation(state);
      loadSavedQueries(dispatch);
      dispatch({ type: "DATA_CHANGED" });
      // Re-saving an INSTANCE operation against the current SCHEMA can lift the suspension on it
      // (and on any sequence whose steps reference it). Refresh the nav so the red highlighting
      // clears immediately, without requiring a manual reload.
      onNavRefresh?.();
      dispatch({ type: "SET_STATUS", message: "Operation saved", kind: "ok" });
      showToast("Operation updated.");
    } catch (error) {
      dispatch({
        type: "SET_STATUS",
        message: error instanceof Error ? error.message : "Save failed",
        kind: "error"
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="builderRunActions">
      <div className="builderRunActionsRow">
        <button
          type="button"
          className="btnPrimary"
          data-testid="builder-save-operation-btn"
          disabled={!canSave || busy}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save operation"}
        </button>
      </div>
      {state.status.kind === "error" ? (
        <p className="builderRunStatus error">{state.status.message}</p>
      ) : null}
    </div>
  );
}

function MutationRunActions({
  onResult,
  onSequenceCreated
}: {
  onResult?: (result: RunResult) => void;
  onSequenceCreated?: (sequenceId: string) => void;
}) {
  const { state, dispatch } = useBuilder();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [savingOp, setSavingOp] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const op = state.query.operation;
  const clauseLabel = state.query.match[0]?.label;
  const showRunButton = builderSelectors.showRunButton(state);
  const canRun = builderSelectors.canCreate(state);
  const canSaveOp = builderSelectors.canSaveOperation(state);

  if (op !== "create") return null;

  async function onRun() {
    setBusy(true);
    dispatch({ type: "SET_STATUS", message: `Running ${op}…`, kind: "info" });
    try {
      if (op === "create") {
        const result = await runCreate(state);
        const graphResult = createResponseToRunResult(result);
        if (graphResult) onResult?.(graphResult);
        loadSavedQueries(dispatch);
        if (
          state.spaceId &&
          (state.query.match[0]?.label === "STEP" || state.query.match[0]?.label === "SCHEMA")
        ) {
          const nested = result.result as { space_labels?: { labels?: string[] } } | undefined;
          const labels = nested?.space_labels?.labels;
          if (labels?.length) {
            dispatch({ type: "SET_SPACE_LABELS", labels });
          } else {
            refreshSpaceLabels(state.spaceId, dispatch);
          }
        }
      }
      // Reset the builder for the next edit; success surfaces as a toast.
      showToast(`${op.toUpperCase()} completed successfully.`);
      // Refresh dropdowns so any newly created graph nodes are immediately selectable.
      dispatch({ type: "DATA_CHANGED" });
      dispatch({ type: "RESET_BUILDER" });
    } catch (error) {
      dispatch({
        type: "SET_STATUS",
        message: error instanceof Error ? error.message : `${op} failed`,
        kind: "error"
      });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateOperationSave(values: CreateOperationFormValues) {
    setSavingOp(true);
    dispatch({ type: "SET_STATUS", message: "Saving operation…", kind: "info" });
    try {
      const result = await saveQueryOperation(state, values);
      loadSavedQueries(dispatch);
      if (state.spaceId) {
        refreshSpaceLabels(state.spaceId, dispatch);
      }
      dispatch({ type: "DATA_CHANGED" });
      regenerateQueryIdAfterOperationSave(dispatch);
      if (values.addAsSequence && result.sequenceId) {
        onSequenceCreated?.(result.sequenceId);
      }
      setShowCreateModal(false);
      showToast(
        values.addAsSequence
          ? "Operation saved to catalog as a one-step sequence."
          : "Operation saved to catalog."
      );
    } catch (error) {
      dispatch({
        type: "SET_STATUS",
        message: error instanceof Error ? error.message : "Save failed",
        kind: "error"
      });
    } finally {
      setSavingOp(false);
    }
  }

  const disabled = busy || savingOp;

  return (
    <>
      <div className="builderRunActions">
        <div className="builderRunActionsRow">
          {showRunButton ? (
            <button
              type="button"
              className="btnPrimary"
              data-testid="builder-run-btn"
              disabled={!canRun || disabled}
              onClick={onRun}
            >
              {runButtonLabel(op, clauseLabel, { busy })}
            </button>
          ) : null}
          <button
            type="button"
            className="btnSecondary"
            data-testid="builder-create-operation-btn"
            disabled={!canSaveOp || disabled}
            onClick={() => setShowCreateModal(true)}
          >
            Create operation
          </button>
        </div>
        {state.status.kind === "error" ? (
          <p className="builderRunStatus error">{state.status.message}</p>
        ) : null}
      </div>

      {showCreateModal ? (
        <CreateOperationModal
          saving={savingOp}
          initialName={state.query.name}
          initialRuntimeEnabled={state.runtimeEnabled}
          existingGroups={state.spaceGroups}
          takenSequenceNames={state.savedQueries
            .filter((q) => q.kind === "sequence" && q.id !== state.query.id)
            .map((q) => q.name.trim().toLowerCase())
            .filter(Boolean)}
          onCancel={() => !savingOp && setShowCreateModal(false)}
          onSave={onCreateOperationSave}
        />
      ) : null}
    </>
  );
}

function CreateSequenceFields({
  name,
  onName,
  description,
  onDescription,
  onGroupTitle,
  existingGroups,
  disabled,
  nameValid,
  nameTaken,
  groupValid,
  initialGroup = "",
  nameLocked = false
}: {
  name: string;
  onName: (value: string) => void;
  description: string;
  onDescription: (value: string) => void;
  onGroupTitle: (value: string) => void;
  existingGroups: string[];
  disabled: boolean;
  nameValid: boolean;
  nameTaken: boolean;
  groupValid: boolean;
  /** Pre-selected group when editing an existing sequence. */
  initialGroup?: string;
  /** Lock the name (it is the sequence's unique STEP attributive_label) when editing. */
  nameLocked?: boolean;
}) {
  const [groupChoice, setGroupChoice] = useState<string>(() => initialGroup);
  const [newGroupTitle, setNewGroupTitle] = useState("");
  const isNewGroup = groupChoice === CREATE_NEW_GROUP;

  // Mirror the resolved group title up to the builder body for validation/save.
  useEffect(() => {
    onGroupTitle(isNewGroup ? newGroupTitle : groupChoice);
  }, [isNewGroup, newGroupTitle, groupChoice, onGroupTitle]);

  return (
    <section className="builderBlock createSequenceFields">
      <div className="builderField">
        <div className="createSequenceLabelRow">
          <label>query name</label>
          {!nameValid ? (
            <span className="createSequenceRequired">Required</span>
          ) : nameTaken ? (
            <span className="createSequenceRequired">Already used by another sequence</span>
          ) : null}
        </div>
        <input
          value={name}
          placeholder="Sequence name"
          disabled={disabled || nameLocked}
          onChange={(e) => onName(e.target.value)}
        />
        {nameLocked ? (
          <span className="createSequenceHint">
            The name is the sequence&rsquo;s unique label and can&rsquo;t be changed here.
          </span>
        ) : null}
      </div>
      <div className="builderField">
        <label>description (optional)</label>
        <textarea
          value={description}
          rows={2}
          placeholder="What this sequence does. Shown to MCP agents as the tool description."
          disabled={disabled}
          onChange={(e) => onDescription(e.target.value)}
        />
      </div>
      <div className="builderField">
        <div className="createSequenceLabelRow">
          <label>group title</label>
          {!groupValid ? <span className="createSequenceRequired">Required</span> : null}
        </div>
        {isNewGroup ? (
          <div className="createSequenceNewGroup">
            <input
              autoFocus
              value={newGroupTitle}
              placeholder="New group title"
              disabled={disabled}
              onChange={(e) => setNewGroupTitle(e.target.value)}
            />
            <button
              type="button"
              className="createSequenceClearBtn"
              aria-label="Back to group list"
              disabled={disabled}
              onClick={() => {
                setGroupChoice("");
                setNewGroupTitle("");
              }}
            >
              ×
            </button>
          </div>
        ) : (
          <Picker
            value={groupChoice}
            placeholder="Please select"
            disabled={disabled}
            options={existingGroups.map((group) => ({ value: group, label: group }))}
            createLabel="+ New group title"
            onCreate={() => setGroupChoice(CREATE_NEW_GROUP)}
            onSelect={(value) => setGroupChoice(value)}
          />
        )}
      </div>
    </section>
  );
}

function CreateSequenceActions({
  name,
  groupTitle,
  description,
  canCreate,
  onSequenceCreated
}: {
  name: string;
  groupTitle: string;
  description: string;
  canCreate: boolean;
  onSequenceCreated?: (sequenceId: string) => void;
}) {
  const { state } = useBuilder();
  const editing = Boolean(state.editSequence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCommit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const fields = {
        name: name.trim(),
        groupTitle: groupTitle.trim(),
        description: description.trim()
      };
      const result =
        editing && state.editSequence
          ? await updateSequencePackage(state, { id: state.editSequence.queryId, ...fields })
          : await saveSequencePackage(state, { id: await connector.generateQueryId(), ...fields });
      // Refresh the nav and open the sequence in place — no full-page reload, so the
      // active space, panel sizes, and builder context all stay put (no white flash).
      onSequenceCreated?.(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : editing ? "Save sequence failed" : "Create sequence failed");
      setBusy(false);
    }
  }

  const label = editing
    ? busy
      ? "Saving…"
      : "Save sequence"
    : busy
      ? "Creating…"
      : "Create sequence";

  return (
    <div className="builderRunActions">
      <div className="builderRunActionsRow">
        <button
          type="button"
          className="btnPrimary"
          data-testid="builder-create-sequence-btn"
          disabled={!canCreate || busy}
          onClick={onCommit}
        >
          {label}
        </button>
      </div>
      {error ? <p className="builderRunStatus error">{error}</p> : null}
    </div>
  );
}

function BuilderBody({
  onResult,
  onSequenceCreated,
  onNavRefresh,
  seed,
  onSeedConsumed,
  onEditOperationActiveChange,
  exitEditOperationRequest
}: {
  onResult?: (result: RunResult) => void;
  onSequenceCreated?: (sequenceId: string) => void;
  onNavRefresh?: () => void;
  seed?: BuilderSeed | null;
  onSeedConsumed?: () => void;
  onEditOperationActiveChange?: (active: boolean) => void;
  exitEditOperationRequest?: number;
}) {
  const { state, dispatch, createSequenceMode, patchQuery } = useBuilder();
  const { showToast } = useToast();
  const prevCreateSequenceMode = useRef(createSequenceMode);
  const baseWarnings = useMemo(() => builderSelectors.warnings(state), [state]);
  // Captured once on mount: an editSequence seed opens the create-sequence builder pre-loaded
  // from a saved sequence (BuilderPanel is remounted per sequence session, so this is stable).
  const editSeed = seed && seed.kind === "editSequence" ? seed : null;
  const editSessionRef = useRef(Boolean(editSeed));
  const editingSequence = Boolean(state.editSequence);
  const editingSequenceId = state.editSequence?.queryId ?? null;
  const [sequenceIdCopied, setSequenceIdCopied] = useState(false);

  const copySequenceId = useCallback(async () => {
    if (!editingSequenceId) return;
    try {
      await navigator.clipboard.writeText(editingSequenceId);
      setSequenceIdCopied(true);
      window.setTimeout(() => setSequenceIdCopied(false), 1500);
    } catch {
      setSequenceIdCopied(false);
      showToast("Couldn't copy the sequence ID.", "error");
    }
  }, [editingSequenceId, showToast]);

  useEffect(() => {
    onEditOperationActiveChange?.(Boolean(state.editOperation));
  }, [state.editOperation, onEditOperationActiveChange]);

  useEffect(() => {
    if (!exitEditOperationRequest) return;
    dispatch({ type: "EXIT_EDIT_OPERATION" });
  }, [exitEditOperationRequest, dispatch]);

  // Sequences must be a single connected pattern (single entry point for the executor).
  const sequenceWarnings = useMemo(
    () => (createSequenceMode ? sequenceEntryPointWarnings(state.query) : []),
    [createSequenceMode, state.query]
  );
  const warnings = useMemo(
    () => [...baseWarnings, ...sequenceWarnings],
    [baseWarnings, sequenceWarnings]
  );
  const [sequenceName, setSequenceName] = useState(() => editSeed?.name ?? "");
  const [sequenceDescription, setSequenceDescription] = useState(() => editSeed?.description ?? "");
  const [sequenceGroupTitle, setSequenceGroupTitle] = useState(() => editSeed?.groupTitle ?? "");

  // A sequence's name becomes its STEP node's attributive_label, which must be unique within
  // the underlying graph; block names already used by another sequence. (The server enforces
  // this authoritatively across spaces sharing the graph; this is the proactive UI guard.)
  const takenSequenceNames = useMemo(
    () =>
      new Set(
        state.savedQueries
          .filter((q) => q.kind === "sequence" && q.id !== state.query.id)
          .map((q) => q.name.trim().toLowerCase())
          .filter(Boolean)
      ),
    [state.savedQueries, state.query.id]
  );

  const sequenceNameValid = sequenceName.trim().length > 0;
  // When editing, the (locked) name is the sequence's own existing label, so the "already used"
  // guard doesn't apply to it.
  const sequenceNameTaken =
    !editingSequence &&
    sequenceNameValid &&
    takenSequenceNames.has(sequenceName.trim().toLowerCase());
  const sequenceGroupValid = sequenceGroupTitle.trim().length > 0;
  const canCreateSequence =
    sequenceNameValid &&
    !sequenceNameTaken &&
    sequenceGroupValid &&
    sequenceWarnings.length === 0;

  // Entering create-sequence mode starts a fresh read/STEP query. Skipped for an edit session,
  // where the saved sequence's builder_config is hydrated instead (see the edit effect below).
  useEffect(() => {
    if (!createSequenceMode || editSessionRef.current) return;
    dispatch({ type: "SET_OPERATION", operation: "read" });
    dispatch({ type: "SET_LABEL", label: "STEP" });
    setSequenceName("");
    setSequenceDescription("");
    setSequenceGroupTitle("");
  }, [createSequenceMode, dispatch]);

  // Edit session: hydrate the builder from the saved sequence's builder_config (its QueryObject
  // snapshot) so the STEP chain can be edited visually and saved back in place. The name/group/
  // description fields are seeded synchronously from the nav summary (above).
  const editSeedNonce = editSeed?.nonce;
  useEffect(() => {
    if (!editSeed) return;
    let cancelled = false;
    connector
      .fetchQueryPackage(editSeed.sequenceId)
      .then((pkg) => {
        if (cancelled) return;
        const config = pkg.builder_config;
        if (isHydratableBuilderConfig(config)) {
          dispatch({
            type: "ENTER_EDIT_SEQUENCE",
            queryId: editSeed.sequenceId,
            query: config.query,
            runtimeEnabled: config.runtimeEnabled ?? true,
            matchPositions: config.matchPositions
          });
        } else {
          showToast(
            "This sequence has no saved builder config, so it can't be edited visually.",
            "error"
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) onSeedConsumed?.();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeedNonce]);

  useEffect(() => {
    if (prevCreateSequenceMode.current && !createSequenceMode) {
      dispatch({ type: "RESET_BUILDER" });
    }
    prevCreateSequenceMode.current = createSequenceMode;
  }, [createSequenceMode, dispatch]);

  // A STEP node clicked in the sequence visualizer asks the builder to load it. A custom-endpoint
  // STEP opens the update STEP flow with that node as the match clause's initial node; an
  // operation-backed STEP (sequencial_properties carry a query_id) opens the locked edit-operation
  // view, hydrated from the saved query's builder_config. `nonce` keys the effect so the same
  // target can be re-applied.
  const seedNonce = seed?.nonce;
  useEffect(() => {
    if (!seed || seed.kind !== "stepNode") return;
    const spaceId = state.spaceId;
    if (!spaceId) {
      onSeedConsumed?.();
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" })
      .then(async (rows) => {
        if (cancelled) return;
        // Prefer an operation-backed node when duplicates share a label (legacy non-idempotent
        // wraps could leave an orphan endpoint node alongside the real one).
        const matches = rows.filter((r) => r.attributive_label === seed.attributiveLabel);
        const row =
          matches.find((r) => (r.sequencial_properties?.query_id || "").trim()) ?? matches[0];
        if (!row) return;
        const queryId = (row.sequencial_properties?.query_id || "").trim();
        if (queryId) {
          // Operation-backed STEP: reload the saved operation into the locked edit view.
          const pkg = await connector.fetchQueryPackage(queryId);
          if (cancelled) return;
          const config = pkg.builder_config;
          if (isHydratableBuilderConfig(config)) {
            dispatch({
              type: "ENTER_EDIT_OPERATION",
              queryId,
              query: config.query,
              runtimeEnabled: config.runtimeEnabled ?? true,
              matchPositions: config.matchPositions
            });
          } else {
            showToast(
              "This operation has no saved builder config, so it can't be edited visually.",
              "error"
            );
          }
        } else {
          // Custom-endpoint STEP: load it into a fresh update STEP flow.
          dispatch({ type: "EXIT_EDIT_OPERATION" });
          dispatch({ type: "SET_OPERATION", operation: "update" });
          dispatch({ type: "SET_LABEL", label: "STEP" });
          patchQuery(
            loadStepNodeIntoQuery(row, { clauseIndex: 0, patternIndex: 0, pathIndex: 0 })
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        // Mark the seed consumed so it is not re-applied if the builder later remounts.
        if (!cancelled) onSeedConsumed?.();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  // A POINTS_TO relationship clicked in the sequence visualizer asks the builder to load it. The
  // builder can't show a relationship on its own, so we open the update-STEP flow with the full
  // `(start)-[rel]->(end)` path: resolve the start node + the outgoing edge (which pins the end
  // node and carries the relationship's stored guard condition), then load all three. `nonce`
  // keys the effect so the same target can be re-applied.
  const relSeedNonce = seed && seed.kind === "stepRelationship" ? seed.nonce : undefined;
  useEffect(() => {
    if (!seed || seed.kind !== "stepRelationship") return;
    const spaceId = state.spaceId;
    if (!spaceId) {
      onSeedConsumed?.();
      return;
    }
    let cancelled = false;
    Promise.all([
      connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" }),
      connector.fetchGraphStepOutgoing({
        spaceId,
        attributiveLabel: seed.startAttributiveLabel
      })
    ])
      .then(([rows, edges]) => {
        if (cancelled) return;
        const startRow = rows.find((r) => r.attributive_label === seed.startAttributiveLabel);
        const edge = edges.find((e) => e.rel_id === seed.relationshipId);
        if (!startRow || !edge) {
          showToast("Couldn't resolve this relationship for editing.", "error");
          return;
        }
        const targetRow = rows.find((r) => r.attributive_label === edge.target_attributive_label);
        dispatch({ type: "ENTER_EDIT_STEP_RELATIONSHIP" });
        patchQuery(
          loadStepRelationshipIntoQuery(startRow, edge, targetRow, {
            clauseIndex: 0,
            patternIndex: 0
          })
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) onSeedConsumed?.();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relSeedNonce]);

  // Load reference data once on mount.
  useEffect(() => {
    loadSavedQueries(dispatch);

    // Regex patterns power string-format validation in property editors. Served by
    // the authenticated /api/regex route (not the instance-admin-only /api/db editor).
    fetch("/api/regex")
      .then((res) => (res.ok ? res.json() : { patterns: [] }))
      .then((data: { patterns?: Array<{ name?: string; regex?: string | null }> }) => {
        const rows = (data.patterns || []).map((r) => ({
          name: String(r.name || ""),
          regex: r.regex ?? null
        }));
        regexValidator.setPatterns(rows);
        dispatch({ type: "SET_REGEX_PATTERNS", patterns: rows });
      })
      .catch(() => undefined);
  }, [dispatch]);

  useEffect(() => {
    if (!state.spaceId) {
      dispatch({ type: "SET_SPACE_LABELS", labels: [] });
      dispatch({ type: "SET_SPACE_GROUPS", groups: [] });
      dispatch({ type: "SET_SPACE_DEV_MODE", value: false });
      return;
    }
    let cancelled = false;
    connector
      .fetchSpaceLabels(state.spaceId)
      .then((labels) => {
        if (!cancelled) dispatch({ type: "SET_SPACE_LABELS", labels });
      })
      .catch(() => undefined);
    connector
      .fetchSpaceGroups(state.spaceId)
      .then((groups) => {
        if (!cancelled) dispatch({ type: "SET_SPACE_GROUPS", groups });
      })
      .catch(() => undefined);
    fetchSpaceRecord(state.spaceId)
      .then((record) => {
        if (!cancelled) dispatch({ type: "SET_SPACE_DEV_MODE", value: Boolean(record.dev_mode) });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "SET_SPACE_DEV_MODE", value: false });
      });
    return () => {
      cancelled = true;
    };
  }, [state.spaceId, dispatch]);

  // Space table endpoint column → default for STEP custom-endpoint fields (legacy form parity).
  useEffect(() => {
    if (!state.spaceId) {
      dispatch({ type: "SET_SPACE_DEFAULT_ENDPOINT", endpoint: "" });
      return;
    }
    let cancelled = false;
    connector
      .fetchSpaceConnections(state.spaceId)
      .then((conn) => {
        if (!cancelled) {
          dispatch({
            type: "SET_SPACE_DEFAULT_ENDPOINT",
            endpoint: (conn.endpoint ?? "").trim()
          });
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "SET_SPACE_DEFAULT_ENDPOINT", endpoint: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [state.spaceId, dispatch]);

  return (
    <div className="builderRoot">
      <fieldset className="builderFormFieldset">
        <div className="builderHeadRow">
          <strong>
            {createSequenceMode
              ? editingSequence
                ? "Edit sequence"
                : "Create a sequence"
              : "Builder"}
          </strong>
          {editingSequence && editingSequenceId ? (
            <button
              type="button"
              className="builderTinyBtn"
              onClick={() => void copySequenceId()}
            >
              {sequenceIdCopied ? "Copied" : "Copy sequence ID"}
            </button>
          ) : null}
        </div>

        {createSequenceMode ? (
          <CreateSequenceFields
            name={sequenceName}
            onName={setSequenceName}
            description={sequenceDescription}
            onDescription={setSequenceDescription}
            onGroupTitle={setSequenceGroupTitle}
            existingGroups={state.spaceGroups}
            disabled={false}
            nameValid={sequenceNameValid}
            nameTaken={sequenceNameTaken}
            groupValid={sequenceGroupValid}
            initialGroup={editSeed?.groupTitle ?? ""}
            nameLocked={editingSequence}
          />
        ) : null}

        <QueryCard />

        {createSequenceMode ? null : <AdvancedOptions />}

        {warnings.length > 0 ? (
          <div className="builderWarnings">
            <strong>Warnings</strong>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {warnings.length === 0 && state.spaceDevMode ? (
          <LivePreview
            createSequenceMode={createSequenceMode}
            sequenceName={sequenceName}
            sequenceGroupTitle={sequenceGroupTitle}
          />
        ) : null}
      </fieldset>

      {createSequenceMode ? (
        <CreateSequenceActions
          name={sequenceName}
          groupTitle={sequenceGroupTitle}
          description={sequenceDescription}
          canCreate={canCreateSequence}
          onSequenceCreated={onSequenceCreated}
        />
      ) : state.editOperation ? (
        <EditOperationActions onNavRefresh={onNavRefresh} />
      ) : (
        <>
          <MutationRunActions onResult={onResult} onSequenceCreated={onSequenceCreated} />
          <QueryRunActions
            onResult={onResult}
            onQueriesReload={() => loadSavedQueries(dispatch)}
            onSequenceCreated={onSequenceCreated}
            onNavRefresh={onNavRefresh}
          />
        </>
      )}
    </div>
  );
}

export function BuilderPanel({
  spaceId,
  onResult,
  createSequenceMode = false,
  onSequenceCreated,
  onNavRefresh,
  seed,
  onSeedConsumed,
  onEditOperationActiveChange,
  exitEditOperationRequest,
  flows = null
}: {
  spaceId: string | null;
  onResult?: (result: RunResult) => void;
  createSequenceMode?: boolean;
  onSequenceCreated?: (sequenceId: string) => void;
  onNavRefresh?: () => void;
  seed?: BuilderSeed | null;
  onSeedConsumed?: () => void;
  onEditOperationActiveChange?: (active: boolean) => void;
  exitEditOperationRequest?: number;
  flows?: string[] | null;
}) {
  return (
    <BuilderProvider
      key={spaceId ?? "no-space"}
      spaceId={spaceId}
      createSequenceMode={createSequenceMode}
      flows={flows}
    >
      <BuilderBody
        onResult={onResult}
        onSequenceCreated={onSequenceCreated}
        onNavRefresh={onNavRefresh}
        seed={seed}
        onSeedConsumed={onSeedConsumed}
        onEditOperationActiveChange={onEditOperationActiveChange}
        exitEditOperationRequest={exitEditOperationRequest}
      />
    </BuilderProvider>
  );
}
