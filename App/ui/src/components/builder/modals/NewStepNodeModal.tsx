import { useState } from "react";
import {
  finalizeAttributiveLabelInput,
  sanitizeAttributiveLabelInput
} from "@pona-flow/authoring";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface NewStepNodeModalProps {
  onCancel: () => void;
  onSave: (attributiveLabel: string) => void;
}

export function NewStepNodeModal({ onCancel, onSave }: NewStepNodeModalProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function save() {
    const v = finalizeAttributiveLabelInput(value);
    if (!v) {
      setError("attributive_label is required.");
      return;
    }
    onSave(v);
  }

  return (
    <ModalBackdrop onClick={onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-new-step-node"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>new node</h2>
        <div className="builderField" data-issue="attributive_label">
          <input
            aria-label="attributive_label"
            autoFocus
            value={value}
            placeholder="Label"
            onChange={(e) => {
              setValue(sanitizeAttributiveLabelInput(e.target.value));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <span className="builderCheckMsg">
            Enter a literal attributive_label (letters, digits, spaces).
          </span>
        </div>
        {error ? <p className="builderCheckMsg error">{error}</p> : null}
        <div className="builderModalActions">
          <button
            type="button"
            className="builderTinyBtn"
            data-testid="modal-cancel-btn"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" data-testid="modal-confirm-btn" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
