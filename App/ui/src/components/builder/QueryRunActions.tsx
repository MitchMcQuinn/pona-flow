import { useState } from "react";
import {
  executeSchemaDeletion,
  executeStepDeletion,
  previewSchemaDeletion,
  previewStepDeletion,
  type SchemaDeletePreview,
  type StepDeletePreview
} from "../../services/api";
import connector from "../../services/connector";
import { runQuery, saveQueryOperation } from "../../services/execute";
import {
  applySchemaUpdate,
  hasSchemaUpdateImpact,
  previewSchemaUpdate,
  type SchemaUpdatePreviewOutcome
} from "../../services/schemaUpdate";
import { regenerateQueryIdAfterOperationSave } from "../../state/builder/afterOperationSave";
import { useBuilder } from "../../state/builder/BuilderContext";
import { builderSelectors } from "../../state/builder/selectors";
import type { BuilderState, RunResult } from "../../state/builder/types";
import { useToast } from "../Toast";
import {
  CreateOperationModal,
  type CreateOperationFormValues
} from "./modals/CreateOperationModal";
import { SchemaDeleteConfirmModal } from "./modals/SchemaDeleteConfirmModal";
import { SchemaUpdateSuspendModal } from "./modals/SchemaUpdateSuspendModal";
import { StepDeleteConfirmModal } from "./modals/StepDeleteConfirmModal";
import { isDestructiveRunButton, runButtonLabel } from "./runButtonLabels";

/** True when the query deletes a SCHEMA pattern (routed through the cascade preview). */
function isSchemaDelete(state: BuilderState): boolean {
  return state.query.operation === "delete" && state.query.match[0]?.label === "SCHEMA";
}

/** True when the query deletes a STEP pattern (routed through the cascade preview). */
function isStepDelete(state: BuilderState): boolean {
  return state.query.operation === "delete" && state.query.match[0]?.label === "STEP";
}

/** attributive_label of the first matched node (the SCHEMA/STEP targeted by a delete). */
function primaryNodeLabel(state: BuilderState): string {
  const clause = state.query.match[0];
  if (!clause) return "";
  for (const pattern of clause.patterns || []) {
    for (const element of pattern.path || []) {
      if (element.kind === "node") {
        const label = (element.node.attributive_label ?? "").trim();
        if (label) return label;
      }
    }
  }
  return "";
}

interface QueryRunActionsProps {
  onResult?: (result: RunResult) => void;
  onQueriesReload: () => void;
  onSequenceCreated?: (sequenceId: string) => void;
  /** Refresh the navigation sequence list (after a cascade that may delete sequences). */
  onNavRefresh?: () => void;
}

/** Run + catalog save actions for read, update, and delete (not create). */
export function QueryRunActions({
  onResult,
  onQueriesReload,
  onSequenceCreated,
  onNavRefresh
}: QueryRunActionsProps) {
  const { state, dispatch } = useBuilder();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [savingOp, setSavingOp] = useState(false);
  const [schemaDeletePreview, setSchemaDeletePreview] = useState<SchemaDeletePreview | null>(null);
  const [stepDeletePreview, setStepDeletePreview] = useState<StepDeletePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Confirmation when a SCHEMA update would suspend one or more sequences.
  const [schemaUpdatePreview, setSchemaUpdatePreview] =
    useState<SchemaUpdatePreviewOutcome | null>(null);
  const [schemaUpdateError, setSchemaUpdateError] = useState<string | null>(null);
  const op = state.query.operation;
  const clauseLabel = state.query.match[0]?.label;
  const schemaDelete = isSchemaDelete(state);
  const stepDelete = isStepDelete(state);
  const showRunButton = builderSelectors.showRunButton(state);
  const canRun = builderSelectors.canRun(state);
  const canSaveOp = builderSelectors.canSaveOperation(state);

  if (op === "create") return null;

  /** Delete SCHEMA: resolve the cascade blast radius and open the confirm modal. */
  async function onPreviewSchemaDelete() {
    const label = primaryNodeLabel(state);
    if (!state.spaceId || !label) {
      dispatch({ type: "SET_STATUS", message: "Select a SCHEMA to delete first.", kind: "error" });
      return;
    }
    setPreviewing(true);
    setDeleteError(null);
    dispatch({ type: "SET_STATUS", message: "Resolving deletion impact…", kind: "info" });
    try {
      const preview = await previewSchemaDeletion(state.spaceId, label);
      setSchemaDeletePreview(preview);
      dispatch({ type: "SET_STATUS", message: "", kind: "info" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed";
      dispatch({ type: "SET_STATUS", message, kind: "error" });
    } finally {
      setPreviewing(false);
    }
  }

  async function onConfirmSchemaDelete() {
    if (!schemaDeletePreview || !state.spaceId) return;
    setConfirmingDelete(true);
    setDeleteError(null);
    try {
      const result = await executeSchemaDeletion(
        state.spaceId,
        schemaDeletePreview.attributive_label
      );
      setSchemaDeletePreview(null);
      onQueriesReload();
      const labels = await connector.fetchSpaceLabels(state.spaceId);
      dispatch({ type: "SET_SPACE_LABELS", labels });
      showToast(
        result.purged
          ? `Schema "${result.attributive_label}" and its dependents were deleted.`
          : `Schema "${result.attributive_label}" was removed from this space.`
      );
      dispatch({ type: "DATA_CHANGED" });
      dispatch({ type: "RESET_BUILDER" });
      onNavRefresh?.();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setConfirmingDelete(false);
    }
  }

  /** Delete STEP: resolve the cascade blast radius and open the confirm modal. */
  async function onPreviewStepDelete() {
    const label = primaryNodeLabel(state);
    if (!state.spaceId || !label) {
      dispatch({ type: "SET_STATUS", message: "Select a STEP to delete first.", kind: "error" });
      return;
    }
    setPreviewing(true);
    setDeleteError(null);
    dispatch({ type: "SET_STATUS", message: "Resolving deletion impact…", kind: "info" });
    try {
      const preview = await previewStepDeletion(state.spaceId, label);
      setStepDeletePreview(preview);
      dispatch({ type: "SET_STATUS", message: "", kind: "info" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed";
      dispatch({ type: "SET_STATUS", message, kind: "error" });
    } finally {
      setPreviewing(false);
    }
  }

  async function onConfirmStepDelete() {
    if (!stepDeletePreview || !state.spaceId) return;
    setConfirmingDelete(true);
    setDeleteError(null);
    try {
      const result = await executeStepDeletion(
        state.spaceId,
        stepDeletePreview.attributive_label
      );
      setStepDeletePreview(null);
      onQueriesReload();
      const labels = await connector.fetchSpaceLabels(state.spaceId);
      dispatch({ type: "SET_SPACE_LABELS", labels });
      showToast(
        result.purged
          ? `Step "${result.attributive_label}" and its dependent sequences were deleted.`
          : `Step "${result.attributive_label}" was removed from this space.`
      );
      dispatch({ type: "DATA_CHANGED" });
      dispatch({ type: "RESET_BUILDER" });
      onNavRefresh?.();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setConfirmingDelete(false);
    }
  }

  /**
   * SCHEMA update (add/delete-only): dry-run first to learn which sequences the change would
   * break and how many live instances would fall out of sync. If anything is affected, open a
   * confirmation modal (cancel aborts the whole update). When nothing is affected, apply
   * immediately.
   */
  async function onSchemaUpdate() {
    setBusy(true);
    dispatch({ type: "SET_STATUS", message: "Checking schema change…", kind: "info" });
    try {
      const preview = await previewSchemaUpdate(state);
      if (hasSchemaUpdateImpact(preview)) {
        setSchemaUpdateError(null);
        setSchemaUpdatePreview(preview);
        dispatch({ type: "SET_STATUS", message: "", kind: "info" });
        return;
      }
      await commitSchemaUpdate(preview);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schema update failed";
      dispatch({ type: "SET_STATUS", message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** Persist a (previously previewed) SCHEMA update and report the suspension fallout. */
  async function commitSchemaUpdate(preview: SchemaUpdatePreviewOutcome) {
    dispatch({ type: "SET_STATUS", message: "Updating schema…", kind: "info" });
    const outcome = await applySchemaUpdate(preview.input);
    const changes: string[] = [];
    if (outcome.added.length) changes.push(`added ${outcome.added.length}`);
    if (outcome.deleted.length) changes.push(`removed ${outcome.deleted.length}`);
    const suspended = outcome.suspension.suspended.length;
    const suspendNote = suspended
      ? ` ${suspended} item${suspended === 1 ? "" : "s"} suspended.`
      : "";
    const marked = outcome.instances.marked;
    const markedNote = marked
      ? ` ${marked} instance${marked === 1 ? "" : "s"} marked out of sync.`
      : "";
    showToast(
      `Schema "${outcome.attributiveLabel}" updated${
        changes.length ? ` (${changes.join(", ")})` : ""
      }.${suspendNote}${markedNote}`
    );
    if (suspended) {
      const names = outcome.suspension.suspended.map((s) => s.name || s.id).join(", ");
      showToast(`Suspended until their INSTANCE step is re-saved: ${names}`);
    }
    onQueriesReload();
    onNavRefresh?.();
    dispatch({ type: "DATA_CHANGED" });
    dispatch({ type: "RESET_BUILDER" });
  }

  /** Confirm handler for the suspension modal: apply the previewed update, then close. */
  async function onConfirmSchemaUpdate() {
    if (!schemaUpdatePreview) return;
    setBusy(true);
    setSchemaUpdateError(null);
    try {
      await commitSchemaUpdate(schemaUpdatePreview);
      setSchemaUpdatePreview(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Schema update failed";
      setSchemaUpdateError(message);
    } finally {
      setBusy(false);
    }
  }

  async function onRun() {
    if (schemaDelete) {
      await onPreviewSchemaDelete();
      return;
    }
    if (stepDelete) {
      await onPreviewStepDelete();
      return;
    }
    if (op === "update" && clauseLabel === "SCHEMA") {
      await onSchemaUpdate();
      return;
    }
    setBusy(true);
    dispatch({ type: "RUN_STARTED" });
    dispatch({ type: "SET_STATUS", message: `Running ${op}…`, kind: "info" });
    try {
      const result = await runQuery(state);
      dispatch({ type: "RUN_SUCCEEDED", result });
      onResult?.(result);
      if (op === "read") {
        dispatch({ type: "SET_STATUS", message: "Read completed.", kind: "ok" });
      } else {
        // Mutations reset the builder for the next edit; success surfaces as a toast.
        showToast(`${op.toUpperCase()} completed successfully.`);
        // Refresh dropdowns so the graph change is reflected immediately.
        dispatch({ type: "DATA_CHANGED" });
        dispatch({ type: "RESET_BUILDER" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${op} failed`;
      dispatch({ type: "RUN_FAILED", error: message });
      dispatch({ type: "SET_STATUS", message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onCreateOperationSave(values: CreateOperationFormValues) {
    setSavingOp(true);
    dispatch({ type: "SET_STATUS", message: "Saving operation…", kind: "info" });
    try {
      const result = await saveQueryOperation(state, values);
      onQueriesReload();
      if (state.spaceId) {
        const labels = await connector.fetchSpaceLabels(state.spaceId);
        dispatch({ type: "SET_SPACE_LABELS", labels });
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

  const disabled = busy || savingOp || previewing || confirmingDelete;
  const runButtonClass = isDestructiveRunButton(op) ? "btnDanger" : "btnPrimary";
  const runButtonLabelText = previewing
    ? "Resolving…"
    : runButtonLabel(op, clauseLabel, { busy });

  return (
    <>
      <div className="builderRunActions">
        <div className="builderRunActionsRow">
          {showRunButton ? (
            <button
              type="button"
              className={runButtonClass}
              data-testid="builder-run-btn"
              disabled={!canRun || disabled}
              onClick={onRun}
            >
              {runButtonLabelText}
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
        ) : state.status.kind === "ok" && !busy && !savingOp && !showCreateModal ? (
          <p className="builderRunStatus ok">{state.status.message}</p>
        ) : null}
      </div>

      {showCreateModal ? (
        <CreateOperationModal
          saving={savingOp}
          existingGroups={state.spaceGroups}
          onCancel={() => !savingOp && setShowCreateModal(false)}
          onSave={onCreateOperationSave}
        />
      ) : null}

      {schemaDeletePreview ? (
        <SchemaDeleteConfirmModal
          preview={schemaDeletePreview}
          busy={confirmingDelete}
          error={deleteError}
          onCancel={() => {
            if (!confirmingDelete) {
              setSchemaDeletePreview(null);
              setDeleteError(null);
            }
          }}
          onConfirm={onConfirmSchemaDelete}
        />
      ) : null}

      {stepDeletePreview ? (
        <StepDeleteConfirmModal
          preview={stepDeletePreview}
          busy={confirmingDelete}
          error={deleteError}
          onCancel={() => {
            if (!confirmingDelete) {
              setStepDeletePreview(null);
              setDeleteError(null);
            }
          }}
          onConfirm={onConfirmStepDelete}
        />
      ) : null}

      {schemaUpdatePreview ? (
        <SchemaUpdateSuspendModal
          attributiveLabel={schemaUpdatePreview.input.attributiveLabel}
          added={schemaUpdatePreview.added}
          deleted={schemaUpdatePreview.deleted}
          affectedSequences={schemaUpdatePreview.affectedSequences}
          affectedOperations={schemaUpdatePreview.affectedOperations}
          outOfSyncInstanceCount={schemaUpdatePreview.outOfSyncInstanceCount}
          busy={busy}
          error={schemaUpdateError}
          onCancel={() => {
            if (!busy) {
              setSchemaUpdatePreview(null);
              setSchemaUpdateError(null);
              dispatch({ type: "SET_STATUS", message: "Schema update cancelled.", kind: "info" });
            }
          }}
          onConfirm={onConfirmSchemaUpdate}
        />
      ) : null}
    </>
  );
}
