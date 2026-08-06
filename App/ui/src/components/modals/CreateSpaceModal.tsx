import { useEffect, useMemo, useState } from "react";
import { fetchSharedSequenceLabels } from "../../services/api";
import {
  isValidSpaceNameInput,
  normalizeSpaceName,
  sanitizeSpaceNameInput
} from "../../utils/spaceName";
import { SpaceLabelsPicker } from "./SpaceLabelsPicker";
import { ModalBackdrop } from "./ModalBackdrop";
import "../builder/builder.css";

export interface CreateSpaceFormValues {
  name: string;
  endpoint: string;
  labels: string[];
}

export type SpaceModalMode = "create" | "edit";

const EMPTY_LABELS: string[] = [];

interface CreateSpaceModalProps {
  mode?: SpaceModalMode;
  /** Catalog space id when editing (unchanged until save). */
  spaceId?: string;
  /** When true the modal cannot be dismissed until a space is created. */
  required?: boolean;
  initialName?: string;
  initialEndpoint?: string;
  initialLabels?: string[];
  /** Exclude this space id from duplicate-name checks (edit mode). */
  excludeSpaceId?: string;
  existingNames: string[];
  saving?: boolean;
  error?: string | null;
  onCancel?: () => void;
  onSubmit: (values: CreateSpaceFormValues) => void;
}

export function CreateSpaceModal({
  mode = "create",
  spaceId,
  required = false,
  initialName = "",
  initialEndpoint = "",
  initialLabels = EMPTY_LABELS,
  excludeSpaceId,
  existingNames,
  saving = false,
  error = null,
  onCancel,
  onSubmit
}: CreateSpaceModalProps) {
  const [name, setName] = useState(initialName);
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [labels, setLabels] = useState<string[]>(initialLabels);
  const [sharedSequenceLabels, setSharedSequenceLabels] = useState<string[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const initialLabelsKey = initialLabels.join("\x1e");

  useEffect(() => {
    setName(initialName);
    setEndpoint(initialEndpoint);
    setLabels(initialLabels);
    setLocalError(null);
  }, [initialName, initialEndpoint, initialLabelsKey, mode, spaceId]);

  useEffect(() => {
    let cancelled = false;
    setLabelsLoading(true);
    fetchSharedSequenceLabels()
      .then((options) => {
        if (!cancelled) setSharedSequenceLabels(options);
      })
      .catch(() => {
        if (!cancelled) setSharedSequenceLabels([]);
      })
      .finally(() => {
        if (!cancelled) setLabelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, spaceId]);

  const trimmedName = name.trim();
  const normalizedName = useMemo(() => normalizeSpaceName(trimmedName), [trimmedName]);
  const excludedNormalized = excludeSpaceId ? normalizeSpaceName(excludeSpaceId) : "";
  const duplicate = useMemo(
    () =>
      normalizedName.length > 0 &&
      existingNames.some((existing) => {
        const normalizedExisting = normalizeSpaceName(existing);
        if (excludedNormalized && normalizedExisting === excludedNormalized) return false;
        return normalizedExisting === normalizedName;
      }),
    [existingNames, normalizedName, excludedNormalized]
  );
  const nameValid = isValidSpaceNameInput(name);
  const canSubmit = nameValid && !duplicate && !saving;

  useEffect(() => {
    setLocalError(null);
  }, [name, endpoint, labels]);

  function save() {
    if (!trimmedName) {
      setLocalError("Name is required.");
      return;
    }
    if (!nameValid) {
      setLocalError("Name may only contain letters, numbers, and spaces.");
      return;
    }
    if (duplicate) {
      setLocalError("A space with this name already exists.");
      return;
    }
    onSubmit({ name: trimmedName, endpoint: endpoint.trim(), labels });
  }

  const displayError = localError || error;
  const isEdit = mode === "edit";
  const showSharedSequences = !labelsLoading && sharedSequenceLabels.length > 0;

  return (
    <ModalBackdrop onClick={required || saving ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-create-space"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{isEdit ? "Edit space" : "Create space"}</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          {required
            ? "Create a space to get started. Connection env keys are derived from the name."
            : isEdit
              ? "Update the space name or endpoint. Renaming recomputes connection env keys."
              : "Add a working environment to the catalog spaces table."}
        </p>

        <div className="builderFormFieldset">
          <div className="builderRow">
            <div className="builderField">
              <label>name</label>
              <input
                autoFocus
                value={name}
                placeholder="e.g. Test space"
                disabled={saving}
                onChange={(e) => setName(sanitizeSpaceNameInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </div>
          </div>

          <div className="builderRow">
            <div className="builderField">
              <label>endpoint (optional)</label>
              <input
                value={endpoint}
                placeholder="https://…"
                disabled={saving}
                onChange={(e) => setEndpoint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </div>
          </div>

          {showSharedSequences ? (
            <div className="builderRow">
              <div className="builderField">
                <label>shared sequences (optional)</label>
                <SpaceLabelsPicker
                  options={sharedSequenceLabels}
                  selected={labels}
                  onChange={setLabels}
                  disabled={saving}
                  loading={labelsLoading}
                />
              </div>
            </div>
          ) : null}

          {displayError ? <p className="builderCheckMsg error">{displayError}</p> : null}
          {duplicate && !displayError ? (
            <p className="builderCheckMsg error">A space with this name already exists.</p>
          ) : null}
        </div>

        <div className="builderModalActions">
          {!required ? (
            <button
              type="button"
              className="builderTinyBtn"
              data-testid="modal-cancel-btn"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="btnPrimary"
            data-testid="modal-confirm-btn"
            disabled={!canSubmit}
            onClick={save}
          >
            {saving
              ? isEdit
                ? "Saving…"
                : "Creating…"
              : isEdit
                ? "Save changes"
                : "Create space"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
