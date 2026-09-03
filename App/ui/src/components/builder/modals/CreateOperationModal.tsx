import { useState } from "react";
import {
  normalizeAttributiveLabel,
  sanitizeAttributiveLabelInput
} from "@pona-flow/authoring";
import { Picker } from "../Picker";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

export const CREATE_NEW_GROUP = "__new_group__";

export interface CreateOperationFormValues {
  name: string;
  groupTitle: string;
  description?: string;
}

interface CreateOperationModalProps {
  onCancel: () => void;
  onSave: (values: CreateOperationFormValues) => void;
  saving?: boolean;
  initialName?: string;
  existingGroups?: string[];
  takenSequenceNames?: string[];
}

export function CreateOperationModal({
  onCancel,
  onSave,
  saving = false,
  initialName = "",
  existingGroups = [],
  takenSequenceNames = []
}: CreateOperationModalProps) {
  const [name, setName] = useState(() => normalizeAttributiveLabel(initialName));
  const [description, setDescription] = useState("");
  const [groupChoice, setGroupChoice] = useState("");
  const [newGroupTitle, setNewGroupTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isNewGroup = groupChoice === CREATE_NEW_GROUP;
  const groupTitle = (isNewGroup ? newGroupTitle : groupChoice).trim();

  function save() {
    const trimmedName = normalizeAttributiveLabel(name);
    if (!trimmedName) {
      setError("Query name is required.");
      return;
    }
    if (!groupTitle) {
      setError("Group title is required.");
      return;
    }
    if (takenSequenceNames.includes(trimmedName.trim().toLowerCase())) {
      setError(`A sequence named "${trimmedName}" already exists.`);
      return;
    }
    onSave({
      name: trimmedName,
      groupTitle,
      description: description.trim() || undefined
    });
  }

  return (
    <ModalBackdrop onClick={saving ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-create-operation"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Create operation</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Save this package as a one-step sequence in the active space.
        </p>

        <div className="builderFormFieldset">
          <div className="builderRow">
            <div className="builderField">
              <label>name</label>
              <input
                autoFocus
                value={name}
                placeholder="Query name"
                disabled={saving}
                onChange={(e) => {
                  setName(sanitizeAttributiveLabelInput(e.target.value));
                  setError(null);
                }}
                onBlur={(e) => setName(normalizeAttributiveLabel(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
            </div>
          </div>

          <div className="builderRow">
            <div className="builderField">
              <label>group title</label>
              {isNewGroup ? (
                <div className="createSequenceNewGroup">
                  <input
                    autoFocus
                    value={newGroupTitle}
                    placeholder="New group title"
                    disabled={saving}
                    onChange={(e) => {
                      setNewGroupTitle(e.target.value);
                      setError(null);
                    }}
                  />
                  <button
                    type="button"
                    className="createSequenceClearBtn"
                    aria-label="Back to group list"
                    disabled={saving}
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
                  disabled={saving}
                  options={existingGroups.map((group) => ({ value: group, label: group }))}
                  createLabel="+ New group title"
                  onCreate={() => setGroupChoice(CREATE_NEW_GROUP)}
                  onSelect={(value) => {
                    setGroupChoice(value);
                    setError(null);
                  }}
                />
              )}
            </div>
          </div>

          <div className="builderRow">
            <div className="builderField">
              <label>description (optional)</label>
              <textarea
                value={description}
                rows={2}
                placeholder="What this sequence does. Shown to MCP agents as the tool description."
                disabled={saving}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
              />
            </div>
          </div>

          {error ? <p className="builderCheckMsg error">{error}</p> : null}
        </div>

        <div className="builderModalActions">
          <button
            type="button"
            className="builderTinyBtn"
            data-testid="modal-cancel-btn"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btnPrimary"
            data-testid="modal-confirm-btn"
            disabled={saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save operation"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
