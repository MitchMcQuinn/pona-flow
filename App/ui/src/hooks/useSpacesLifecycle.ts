/**
 * Space catalog + principal lifecycle for App: the initial spaces/me fetches,
 * per-space permission and label loads, the create/edit/delete space flows
 * (modal state + handlers), and the no-access signout for principals with no
 * spaces and no create capability.
 */

import { useCallback, useEffect, useState, type Dispatch } from "react";
import {
  createSpace,
  deleteSpace,
  fetchMe,
  fetchSpacePermissions,
  fetchSpaceRecord,
  fetchSpaces,
  updateSpace
} from "../services/api";
import uiPersistence from "../services/uiPersistence";
import type { AppEvent } from "../state/events";
import type { AppState } from "../state/types";

export function useSpacesLifecycle(options: {
  state: AppState;
  dispatch: Dispatch<AppEvent>;
  showToast: (message: string, kind?: "error") => void;
  signOut: () => Promise<unknown> | void;
  /** Clears the visualization before opening a full-screen panel/modal. */
  dismissVisualization: () => void;
}) {
  const { state, dispatch, showToast, signOut, dismissVisualization } = options;

  const [spaces, setSpaces] = useState<Array<{ id: string; label: string }>>([]);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [spacesLoaded, setSpacesLoaded] = useState(false);
  const [createSpaceModal, setCreateSpaceModal] = useState<{
    open: boolean;
    required: boolean;
  }>({ open: false, required: false });
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const [editSpaceError, setEditSpaceError] = useState<string | null>(null);
  const [savingSpaceEdit, setSavingSpaceEdit] = useState(false);
  const [deleteSpaceModal, setDeleteSpaceModal] = useState<{
    open: boolean;
    spaceId: string;
    spaceName: string;
  } | null>(null);
  const [deleteSpaceError, setDeleteSpaceError] = useState<string | null>(null);
  const [deletingSpace, setDeletingSpace] = useState(false);
  // Shared-sequence labels selected for the active space; the nav only shows sequences
  // whose attributive_label is in this set. Bumping spaceLabelsVersion refetches after
  // a create/edit that keeps the same space id selected.
  const [activeSpaceLabels, setActiveSpaceLabels] = useState<string[]>([]);
  const [spaceLabelsVersion, setSpaceLabelsVersion] = useState(0);

  const bumpSpaceLabelsVersion = useCallback(() => {
    setSpaceLabelsVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    fetchSpaces()
      .then((result) => {
        setSpaces(result);
        setSpacesLoaded(true);
        if (result.length === 0) {
          // Whether to prompt a first-space creation or show the no-access screen is
          // derived from the principal's capability once /api/me resolves.
          return;
        }
        // Restore the operator's last-selected space across refreshes so they land back
        // where they were instead of always defaulting to the first space.
        const persistedSpaceId = uiPersistence.getSpaceId();
        const restored =
          persistedSpaceId && result.some((space) => space.id === persistedSpaceId)
            ? persistedSpaceId
            : result[0].id;
        dispatch({ type: "SPACE_SELECTED", spaceId: restored });
      })
      .catch((error: unknown) => {
        setSpacesLoaded(true);
        setSpacesError(error instanceof Error ? error.message : "Unable to load spaces");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the authenticated principal once on mount (drives space-create gating + Users UI).
  useEffect(() => {
    fetchMe()
      .then((me) => dispatch({ type: "ME_LOADED", me }))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A signed-in principal with no spaces who also cannot create one has no access to
  // anything in this instance. Rather than trapping them behind the required
  // create-space modal, show a no-access screen and sign them out automatically.
  const meLoaded = state.me !== null;
  const canCreateSpaces = Boolean(state.me?.canCreateSpaces || state.me?.isSuperadmin);
  const hasNoSpaces = spacesLoaded && spaces.length === 0 && !spacesError;
  const noAccess = hasNoSpaces && meLoaded && !canCreateSpaces;

  useEffect(() => {
    if (!noAccess) return;
    const timer = window.setTimeout(() => {
      void signOut();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [noAccess, signOut]);

  // Load the caller's effective permissions whenever the active space changes.
  useEffect(() => {
    if (!state.spaceId) {
      dispatch({ type: "PERMISSIONS_LOADED", permissions: null });
      return;
    }
    let cancelled = false;
    fetchSpacePermissions(state.spaceId)
      .then((permissions) => {
        if (!cancelled) dispatch({ type: "PERMISSIONS_LOADED", permissions });
      })
      .catch(() => {
        if (cancelled) return;
        // Fail closed: a failed permissions load must not leave the builder
        // unrestricted (null = still loading = temporarily permissive).
        dispatch({
          type: "PERMISSIONS_LOADED",
          permissions: { flows: [], sequences: { all: false, ids: [] }, manageSpace: false }
        });
        showToast("Failed to load your permissions for this space; actions are disabled.", "error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.spaceId, showToast]);

  useEffect(() => {
    if (!state.spaceId) {
      setActiveSpaceLabels([]);
      return;
    }
    let cancelled = false;
    fetchSpaceRecord(state.spaceId)
      .then((record) => {
        if (!cancelled) setActiveSpaceLabels(record.labels ?? []);
      })
      .catch(() => {
        if (!cancelled) setActiveSpaceLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.spaceId, spaceLabelsVersion]);

  async function reloadSpaces(selectId?: string | null) {
    const result = await fetchSpaces();
    setSpaces(result);
    if (result.length === 0) {
      dispatch({ type: "SPACE_SELECTED", spaceId: null });
      return result;
    }
    setCreateSpaceModal((prev) => (prev.required ? { open: false, required: false } : prev));
    const nextId =
      selectId && result.some((space) => space.id === selectId) ? selectId : result[0]?.id;
    dispatch({ type: "SPACE_SELECTED", spaceId: nextId ?? null });
    return result;
  }

  async function handleCreateSpace(values: { name: string; endpoint: string; labels: string[] }) {
    setCreatingSpace(true);
    setCreateSpaceError(null);
    try {
      const created = await createSpace(values);
      await reloadSpaces(created.id);
      bumpSpaceLabelsVersion();
      setCreateSpaceModal({ open: false, required: false });
    } catch (error: unknown) {
      setCreateSpaceError(error instanceof Error ? error.message : "Failed to create space");
    } finally {
      setCreatingSpace(false);
    }
  }

  function openCreateSpaceModal() {
    dismissVisualization();
    setCreateSpaceError(null);
    setCreateSpaceModal({ open: true, required: false });
  }

  function closeCreateSpaceModal() {
    if (createSpaceModal.required) return;
    setCreateSpaceError(null);
    setCreateSpaceModal({ open: false, required: false });
  }

  async function handleUpdateSpace(values: { name: string; endpoint?: string; labels?: string[] }) {
    if (!state.spaceId) return;
    setSavingSpaceEdit(true);
    setEditSpaceError(null);
    try {
      const updated = await updateSpace(state.spaceId, values);
      await reloadSpaces(updated.id);
      bumpSpaceLabelsVersion();
      dispatch({ type: "SPACE_PANEL_OPENED" });
    } catch (error: unknown) {
      setEditSpaceError(error instanceof Error ? error.message : "Failed to update space");
    } finally {
      setSavingSpaceEdit(false);
    }
  }

  function openDeleteSpaceModal() {
    if (!state.spaceId) return;
    const spaceName = spaces.find((space) => space.id === state.spaceId)?.label ?? state.spaceId;
    setDeleteSpaceError(null);
    setDeleteSpaceModal({ open: true, spaceId: state.spaceId, spaceName });
  }

  function closeDeleteSpaceModal() {
    setDeleteSpaceError(null);
    setDeleteSpaceModal(null);
  }

  async function handleDeleteSpaceConfirm() {
    if (!deleteSpaceModal) return;
    setDeletingSpace(true);
    setDeleteSpaceError(null);
    try {
      const deletedId = deleteSpaceModal.spaceId;
      await deleteSpace(deletedId);
      const keepSelected = state.spaceId !== deletedId ? state.spaceId : null;
      await reloadSpaces(keepSelected);
      setDeleteSpaceModal(null);
    } catch (error: unknown) {
      setDeleteSpaceError(error instanceof Error ? error.message : "Failed to delete space");
    } finally {
      setDeletingSpace(false);
    }
  }

  // First-space bootstrap: only prompt creation for principals who are allowed to.
  const bootstrapCreateSpace = hasNoSpaces && meLoaded && canCreateSpaces;
  const showCreateSpaceModal = !noAccess && (createSpaceModal.open || bootstrapCreateSpace);
  const createSpaceRequired = createSpaceModal.required || bootstrapCreateSpace;

  return {
    spaces,
    spacesError,
    activeSpaceLabels,
    bumpSpaceLabelsVersion,
    noAccess,
    showCreateSpaceModal,
    createSpaceRequired,
    creatingSpace,
    createSpaceError,
    openCreateSpaceModal,
    closeCreateSpaceModal,
    handleCreateSpace,
    savingSpaceEdit,
    editSpaceError,
    handleUpdateSpace,
    deleteSpaceModal,
    deleteSpaceError,
    deletingSpace,
    openDeleteSpaceModal,
    closeDeleteSpaceModal,
    handleDeleteSpaceConfirm
  };
}
