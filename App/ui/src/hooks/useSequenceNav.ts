/**
 * Sequence navigation lifecycle for App: the per-space sequence/group list
 * loads, the selected-sequence loads (definition + stored read query preview for
 * multi-step, EXECUTION compose for every sequence), nav reorder/group handlers,
 * and delete (nav-only / STEP cascade for multi-step; operation+wrap for one-step).
 */

import { useEffect, useState, type Dispatch } from "react";
import {
  composeSequence,
  deleteSequenceDefinition,
  executeOperationDeletion,
  executeStepDeletion,
  fetchNavSequences,
  fetchSequenceDefinition,
  fetchSpaceGroups,
  previewOperationDeletion,
  previewStepDeletion,
  reorderSequences,
  runSequenceQuery,
  setSpaceGroups,
  type ComposedSequence,
  type OperationDeletePreview,
  type StepDeletePreview
} from "../services/api";
import type { SequenceDeleteMode } from "../components/modals/SequenceDeleteConfirmModal";
import { buildNavGroups, flattenNavGroups, reindexSequences } from "../state/navOrder";
import type { AppEvent } from "../state/events";
import type { RunResult } from "../state/builder/types";
import type { AppState, SequenceSummary } from "../state/types";

/** Engine `preview_step_deletion` when the sequence's entry STEP is gone from the graph. */
function isMissingStepError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /No STEP node with attributive_label/i.test(message);
}

export function useSequenceNav(options: {
  state: AppState;
  dispatch: Dispatch<AppEvent>;
  showToast: (message: string, kind?: "error") => void;
  /** Surfaces the selected sequence's stored read-query result in the visualization. */
  setBuilderResult: (result: RunResult | null) => void;
  /** One-shot restore of the persisted sequence view after the first list load. */
  maybeRestoreSequence: (sequences: SequenceSummary[]) => void;
  /** Refetches the per-space label filter after creates/deletes register new labels. */
  bumpSpaceLabelsVersion: () => void;
}) {
  const { state, dispatch, showToast, setBuilderResult, maybeRestoreSequence, bumpSpaceLabelsVersion } =
    options;

  // Sequence deletion offers two paths in SequenceDeleteConfirmModal: a "nav-only" removal of the
  // definition, or the full STEP delete cascade. We preview the cascade blast radius up front so
  // the modal can show it if the user picks that option. `preview` is null when the entry STEP is
  // missing — cascade isn't available, but the catalog row can still be removed from the nav.
  const [sequenceDelete, setSequenceDelete] = useState<{
    sequenceId: string;
    label: string;
    preview: StepDeletePreview | null;
  } | null>(null);
  const [operationDelete, setOperationDelete] = useState<{
    sequenceId: string;
    label: string;
    preview: OperationDeletePreview;
  } | null>(null);
  const [deletingSequence, setDeletingSequence] = useState(false);
  const [sequenceDeleteError, setSequenceDeleteError] = useState<string | null>(null);
  // True while a selected sequence's stored read query is still in flight. Used to hold the
  // visualization on a single loading state so the design graph doesn't render and then get
  // swapped out for the read-query result graph (a jarring flicker on selection).
  const [sequencePreviewLoading, setSequencePreviewLoading] = useState(false);
  const [composedSequence, setComposedSequence] = useState<ComposedSequence | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.spaceId) return;
    dispatch({ type: "SEQUENCES_LOAD_STARTED" });
    fetchNavSequences(state.spaceId)
      .then((sequences) => {
        dispatch({ type: "SEQUENCES_LOAD_SUCCEEDED", sequences });
        maybeRestoreSequence(sequences);
      })
      .catch((error: unknown) => {
        dispatch({
          type: "SEQUENCES_LOAD_FAILED",
          error: error instanceof Error ? error.message : "Unable to load sequences"
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId]);

  useEffect(() => {
    if (!state.spaceId) return;
    let cancelled = false;
    fetchSpaceGroups(state.spaceId)
      .then((groups) => {
        if (!cancelled) dispatch({ type: "GROUPS_LOADED", groups });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId]);

  const selectedSingleStep = Boolean(
    state.nav.sequences.find((sequence) => sequence.id === state.nav.selectedSequenceId)?.singleStep
  );

  useEffect(() => {
    if (!state.nav.selectedSequenceId || !state.spaceId) return;
    const sequenceId = state.nav.selectedSequenceId;
    const spaceId = state.spaceId;
    const singleStep = selectedSingleStep;
    let cancelled = false;

    if (!singleStep) {
      dispatch({ type: "SEQUENCE_LOAD_STARTED" });
      fetchSequenceDefinition(sequenceId, spaceId)
        .then((definition) => {
          if (!cancelled) dispatch({ type: "SEQUENCE_LOAD_SUCCEEDED", definition });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            dispatch({
              type: "SEQUENCE_LOAD_FAILED",
              error: error instanceof Error ? error.message : "Unable to load sequence definition"
            });
          }
        });

      // Run the sequence's stored read query and surface results in the visualization panel.
      setSequencePreviewLoading(true);
      runSequenceQuery(sequenceId, spaceId)
        .then((result) => {
          if (!cancelled) setBuilderResult(result);
        })
        .catch(() => {
          if (!cancelled) setBuilderResult(null);
        })
        .finally(() => {
          if (!cancelled) setSequencePreviewLoading(false);
        });
    } else {
      setBuilderResult(null);
      setSequencePreviewLoading(false);
    }

    // Compose the EXECUTION package (persisted as an inactive state row) for the executor.
    setComposedSequence(null);
    setComposeError(null);
    composeSequence(sequenceId, spaceId)
      .then((composed) => {
        if (!cancelled) setComposedSequence(composed);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setComposedSequence(null);
          setComposeError(
            error instanceof Error ? error.message : "Failed to compose the sequence."
          );
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nav.selectedSequenceId, state.spaceId, selectedSingleStep]);

  useEffect(() => {
    if (!composedSequence) return;
    // Don't surface every step's inputs up front. The executor reveals each step's required
    // parameters progressively (as a `pending` pause) when it reaches that step, so we start
    // with an empty input schema and only publish the response-parameter (output) definitions.
    const responseParams = (composedSequence.package.response_parameters ?? []).map(
      (responseParam) => ({
        parameter: responseParam.parameter,
        propertyPath: responseParam.property_path,
        defaultValue: responseParam.default_value
      })
    );
    dispatch({ type: "SEQUENCE_PARAMS_RESOLVED", schema: [], responseParams });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composedSequence]);

  function persistSequenceOrder(reordered: SequenceSummary[]) {
    reorderSequences(
      reordered.map((sequence) => ({
        id: sequence.id,
        groupTitle: sequence.groupTitle,
        sortOrder: sequence.sortOrder ?? 0
      }))
    ).catch(() => {
      // Re-sync from the server if the write failed so the UI doesn't drift.
      if (!state.spaceId) return;
      fetchNavSequences(state.spaceId)
        .then((sequences) => dispatch({ type: "SEQUENCES_LOAD_SUCCEEDED", sequences }))
        .catch(() => undefined);
    });
  }

  function reloadGroups() {
    if (!state.spaceId) return;
    fetchSpaceGroups(state.spaceId)
      .then((groups) => dispatch({ type: "GROUPS_LOADED", groups }))
      .catch(() => undefined);
  }

  // Refresh the nav in place after a sequence is created (no full-page reload), then
  // open the new sequence. Bumping the labels version refetches the per-space label
  // filter so the freshly registered attributive_label is included.
  async function handleSequenceCreated(sequenceId: string) {
    bumpSpaceLabelsVersion();
    if (!state.spaceId) return;
    try {
      const sequences = await fetchNavSequences(state.spaceId);
      dispatch({ type: "SEQUENCES_LOAD_SUCCEEDED", sequences });
      const created = sequences.find((sequence) => sequence.id === sequenceId);
      if (created) {
        dispatch({ type: "SEQUENCE_SELECTED", sequenceId });
      }
      reloadGroups();
    } catch {
      // Non-fatal: the labels-version bump already triggers a refetch path.
    }
  }

  // Refresh the nav in place after a cascade delete (STEP/SCHEMA) that may have removed
  // dependent sequences, so they disappear from the nav without a full-page reload.
  async function handleNavRefresh() {
    bumpSpaceLabelsVersion();
    if (!state.spaceId) return;
    try {
      const sequences = await fetchNavSequences(state.spaceId);
      dispatch({ type: "SEQUENCES_LOAD_SUCCEEDED", sequences });
      reloadGroups();
    } catch {
      // Non-fatal: the labels-version bump already triggers a refetch path.
    }
  }

  function handleReorderSequences(reordered: SequenceSummary[]) {
    // Keep every row not present in the reordered (visible) set untouched — that's
    // operations/system rows plus any sequences hidden from this space's nav view.
    const reorderedIds = new Set(reordered.map((sequence) => sequence.id));
    const others = state.nav.sequences.filter((sequence) => !reorderedIds.has(sequence.id));
    dispatch({ type: "SEQUENCES_REORDERED", sequences: [...others, ...reordered] });
    persistSequenceOrder(reordered);
  }

  function persistGroups(groups: string[]) {
    if (!state.spaceId) return;
    setSpaceGroups(state.spaceId, groups).catch(() => reloadGroups());
  }

  function handleReorderGroups(groups: string[]) {
    dispatch({ type: "GROUPS_CHANGED", groups });
    persistGroups(groups);
  }

  function handleAddGroup(title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (state.nav.groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())) return;
    const groups = [...state.nav.groups, trimmed];
    dispatch({ type: "GROUPS_CHANGED", groups });
    persistGroups(groups);
  }

  function handleDeleteGroup(title: string) {
    const navSequences = state.nav.sequences.filter((sequence) => sequence.kind === "sequence");
    const affected = navSequences.filter((sequence) => (sequence.groupTitle ?? null) === title);
    if (
      affected.length > 0 &&
      !window.confirm(`Delete group "${title}"? Its sequences will move to Ungrouped.`)
    ) {
      return;
    }

    const groups = state.nav.groups.filter((g) => g !== title);

    if (affected.length === 0) {
      dispatch({ type: "GROUPS_CHANGED", groups });
      persistGroups(groups);
      return;
    }

    // Move the deleted group's sequences to Ungrouped, placed at the very bottom.
    const display = flattenNavGroups(buildNavGroups(navSequences, state.nav.groups));
    const kept = display.filter((sequence) => (sequence.groupTitle ?? null) !== title);
    const moved = display
      .filter((sequence) => (sequence.groupTitle ?? null) === title)
      .map((sequence) => ({ ...sequence, groupTitle: null }));
    const reordered = reindexSequences([...kept, ...moved]);
    const others = state.nav.sequences.filter((sequence) => sequence.kind !== "sequence");

    dispatch({ type: "GROUPS_CHANGED", groups, sequences: [...others, ...reordered] });
    persistGroups(groups);
    persistSequenceOrder(reordered);
  }

  // Delete a sequence by resolving its entry STEP's delete cascade (the work that already knows
  // how to remove a sequence and its dependents). Preview first, then confirm in the modal. If
  // the STEP is gone, still open the modal so the orphaned catalog row can be removed from nav.
  async function handleDeleteSequence(sequenceId: string) {
    const target = state.nav.sequences.find((sequence) => sequence.id === sequenceId);
    if (!target || !state.spaceId) return;
    const label = target.attributiveLabel.trim();
    setSequenceDeleteError(null);
    if (target.singleStep) {
      try {
        const preview = await previewOperationDeletion(state.spaceId, { sequenceId });
        setOperationDelete({ sequenceId, label: target.label, preview });
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Failed to resolve the deletion impact.",
          "error"
        );
      }
      return;
    }
    if (!label || target.orphaned) {
      setSequenceDelete({ sequenceId, label: target.label, preview: null });
      return;
    }
    try {
      const preview = await previewStepDeletion(state.spaceId, label);
      setSequenceDelete({ sequenceId, label: target.label, preview });
    } catch (error) {
      if (isMissingStepError(error)) {
        setSequenceDelete({ sequenceId, label: target.label, preview: null });
        return;
      }
      showToast(
        error instanceof Error ? error.message : "Failed to resolve the deletion impact.",
        "error"
      );
    }
  }

  async function handleConfirmDeleteSequence(mode: SequenceDeleteMode) {
    if (!sequenceDelete || !state.spaceId) return;
    if (mode === "cascade" && !sequenceDelete.preview) {
      setSequenceDeleteError(
        "This sequence's entry STEP is missing, so only a navigation removal is available."
      );
      return;
    }
    setDeletingSequence(true);
    setSequenceDeleteError(null);
    try {
      // "nav" removes only this sequence's definition; "cascade" tears down the entry STEP and
      // every dependent entity via the existing STEP delete cascade.
      const deletedIds = new Set<string>([sequenceDelete.sequenceId]);
      let message: string;
      if (mode === "nav") {
        await deleteSequenceDefinition(state.spaceId, sequenceDelete.sequenceId);
        message = `Sequence "${sequenceDelete.label}" was removed from the navigation.`;
      } else {
        const preview = sequenceDelete.preview;
        if (!preview) return;
        await executeStepDeletion(state.spaceId, preview.attributive_label);
        preview.affected.sequences.forEach((sequence) => deletedIds.add(sequence.id));
        message = `Sequence "${sequenceDelete.label}" and its dependents were deleted.`;
      }
      if (state.nav.selectedSequenceId && deletedIds.has(state.nav.selectedSequenceId)) {
        dispatch({ type: "OPEN_BUILDER" });
      }
      setSequenceDelete(null);
      showToast(message);
      handleNavRefresh();
    } catch (error) {
      setSequenceDeleteError(error instanceof Error ? error.message : "Failed to delete sequence.");
    } finally {
      setDeletingSequence(false);
    }
  }

  async function handleConfirmDeleteOperation() {
    if (!operationDelete || !state.spaceId) return;
    setDeletingSequence(true);
    setSequenceDeleteError(null);
    try {
      const result = await executeOperationDeletion(state.spaceId, {
        sequenceId: operationDelete.sequenceId
      });
      const deletedIds = new Set<string>([
        operationDelete.sequenceId,
        ...result.one_step_deleted
      ]);
      if (state.nav.selectedSequenceId && deletedIds.has(state.nav.selectedSequenceId)) {
        dispatch({ type: "OPEN_BUILDER" });
      }
      const suspended = result.multi_step_suspended.length;
      const message = suspended
        ? `Deleted "${operationDelete.label}" and suspended ${suspended} dependent ${
            suspended === 1 ? "sequence" : "sequences"
          }.`
        : `Deleted operation "${operationDelete.label}" and its one-step sequence.`;
      setOperationDelete(null);
      showToast(message);
      handleNavRefresh();
    } catch (error) {
      setSequenceDeleteError(error instanceof Error ? error.message : "Failed to delete operation.");
    } finally {
      setDeletingSequence(false);
    }
  }

  function cancelSequenceDelete() {
    if (!deletingSequence) {
      setSequenceDelete(null);
      setOperationDelete(null);
      setSequenceDeleteError(null);
    }
  }

  return {
    composedSequence,
    composeError,
    sequencePreviewLoading,
    sequenceDelete,
    operationDelete,
    deletingSequence,
    sequenceDeleteError,
    cancelSequenceDelete,
    handleSequenceCreated,
    handleNavRefresh,
    handleReorderSequences,
    handleReorderGroups,
    handleAddGroup,
    handleDeleteGroup,
    handleDeleteSequence,
    handleConfirmDeleteSequence,
    handleConfirmDeleteOperation
  };
}
