import { useEffect, useState } from "react";
import { ModalBackdrop } from "../modals/ModalBackdrop";
import "../builder/builder.css";

interface ResetConfirmModalProps {
  title: string;
  description: string;
  phrase: string;
  saving?: boolean;
  error?: string | null;
  confirmLabel: string;
  testId: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ResetConfirmModal({
  title,
  description,
  phrase,
  saving = false,
  error = null,
  confirmLabel,
  testId,
  onCancel,
  onConfirm
}: ResetConfirmModalProps) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    setTyped("");
  }, [phrase]);

  const matches = typed.trim() === phrase.trim();

  return (
    <ModalBackdrop onClick={saving ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {description}
        </p>
        <div className="builderField">
          <label htmlFor="reset-confirm-input">
            Type <strong>{phrase}</strong> to confirm
          </label>
          <input
            id="reset-confirm-input"
            data-testid="reset-confirm-input"
            value={typed}
            autoFocus
            disabled={saving}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches && !saving) onConfirm();
            }}
          />
        </div>
        {error ? <p className="builderCheckMsg error">{error}</p> : null}
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
            className="btnDanger"
            data-testid="reset-confirm-btn"
            disabled={saving || !matches}
            onClick={onConfirm}
          >
            {saving ? "Resetting…" : confirmLabel}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
