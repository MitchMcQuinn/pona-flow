import { useState } from "react";
import {
  normalizeAttributiveLabel,
  sanitizeAttributiveLabelInput
} from "../../../state/builder/normalizeField";
import { Picker } from "../Picker";
import { Toggle } from "../Toggle";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

export const CREATE_NEW_GROUP = "__new_group__";

export interface CreateOperationFormValues {
  name: string;
  runtimeEnabled: boolean;
  addAsSequence: boolean;
  groupTitle?: string;
  description?: string;
}

interface CreateOperationModalProps {
  onCancel: () => void;
  onSave: (values: CreateOperationFormValues) => void;
  saving?: boolean;
  initialName?: string;
  initialRuntimeEnabled?: boolean;
  existingGroups?: string[];
  takenSequenceNames?: string[];
}

export function CreateOperationModal({
  onCancel,
  onSave,
  saving = false,
  initialName = "",
  initialRuntimeEnabled = true,
  existingGroups = [],
  takenSequenceNames = []
}: CreateOperationModalProps) {
  const [name, setName] = useState(() => normalizeAttributiveLabel(initialName));
  const [description, setDescription] = useState("");
  const [runtimeEnabled, setRuntimeEnabled] = useState(initialRuntimeEnabled);
  const [addAsSequence, setAddAsSequence] = useState(false);
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
    if (addAsSequence && !groupTitle) {
      setError("Group title is required when adding as a sequence.");
      return;
    }
    // A sequence's name becomes its STEP node's attributive_label and must be unique within
    // the graph; the server enforces this across spaces sharing the graph.
    if (
      addAsSequence &&
      takenSequenceNames.includes(trimmedName.trim().toLowerCase())
    ) {
      setError(`A sequence named "${trimmedName}" already exists.`);
      return;
    }
    onSave({
      name: trimmedName,
      runtimeEnabled,
      addAsSequence,
      groupTitle: addAsSequence ? groupTitle : undefined,
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
          Save this package to the catalog queries table for the active space.
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

          {addAsSequence ? (
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
          ) : null}

          <div className="builderRow">
            <div className="builderField">
              <label>description (optional)</label>
              <textarea
                value={description}
                rows={2}
                placeholder={
                  addAsSequence
                    ? "What this sequence does. Shown to MCP agents as the tool description."
                    : "What this operation does. Shown to MCP agents as the tool description."
                }
                disabled={saving}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setError(null);
                }}
              />
            </div>
          </div>

          <div className="builderRow builderRowToggles">
            <Toggle
              checked={runtimeEnabled}
              onChange={setRuntimeEnabled}
              label="runtime enabled"
              labelFirst
              disabled={saving}
            />
            <Toggle
              checked={addAsSequence}
              onChange={(checked) => {
                setAddAsSequence(checked);
                setError(null);
              }}
              label="add as sequence"
              labelFirst
              disabled={saving}
            />
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
