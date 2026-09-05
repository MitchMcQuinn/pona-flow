import { useState } from "react";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface NewStepNodeModalProps {
  onCancel: () => void;
  onSave: (attributiveLabel: string) => void;
}

// Normalize to an attributive_label (uppercase letters, digits, underscores).
// Parameters ($...) are not accepted: create-STEP identity must be a literal.
function sanitizeInput(raw: string): string {
  return raw
    .replace(/\s+/g, "_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

export function NewStepNodeModal({ onCancel, onSave }: NewStepNodeModalProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function save() {
    const v = sanitizeInput(value);
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
        <h3 style={{ marginTop: 0 }}>New node</h3>
        <div className="builderField">
          <label>attributive_label</label>
          <input
            autoFocus
            value={value}
            placeholder="Label"
            onChange={(e) => {
              setValue(sanitizeInput(e.target.value));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <span className="builderCheckMsg">
            Enter a literal attributive_label (letters, digits, underscores).
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
