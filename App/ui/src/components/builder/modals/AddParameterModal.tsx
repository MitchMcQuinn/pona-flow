import { useState } from "react";
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface AddParameterModalProps {
  onCancel: () => void;
  onSave: (parameter: string) => void;
}

// Keep a leading $ and only identifier characters after it; this field accepts
// a parameter reference exclusively (e.g. "$companyType").
function sanitizeInput(raw: string): string {
  const trimmed = raw.trim();
  const body = (trimmed.startsWith("$") ? trimmed.slice(1) : trimmed).replace(/[^A-Za-z0-9_]/g, "");
  return "$" + body;
}

export function AddParameterModal({ onCancel, onSave }: AddParameterModalProps) {
  const [value, setValue] = useState("$");
  const [error, setError] = useState<string | null>(null);

  function save() {
    const t = value.trim();
    if (!isAttributiveLabelParameter(t)) {
      setError('enter a valid parameter like "$companyType".');
      return;
    }
    onSave(t);
  }

  return (
    <ModalBackdrop onClick={onCancel}>
      <div className="builderModalPanel" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>add a parameter</h2>
        <div className="builderField">
          <label>parameter</label>
          <input
            autoFocus
            className="builderMono"
            value={value}
            placeholder="$parameter"
            onChange={(e) => {
              setValue(sanitizeInput(e.target.value));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <span className="builderCheckMsg">
            supplied at run time. set its value in the parameters card.
          </span>
        </div>
        {error ? <p className="builderCheckMsg error">{error}</p> : null}
        <div className="builderModalActions">
          <button type="button" className="builderTinyBtn" onClick={onCancel}>
            cancel
          </button>
          <button type="button" onClick={save}>
            add
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
