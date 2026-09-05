import { ModalBackdrop } from "./ModalBackdrop";
import type { OperationDeletePreview } from "../../services/api";
import "../builder/builder.css";

interface OperationDeleteSuspendModalProps {
  sequenceLabel: string;
  preview: OperationDeletePreview;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirm deleting a one-step sequence wrap: the operation, its STEP, and the
 * one-step catalog row go away. Multi-step sequences that MATCH the wrap are
 * listed and will be suspended (red, cannot run) until resaved.
 */
export function OperationDeleteSuspendModal({
  sequenceLabel,
  preview,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: OperationDeleteSuspendModalProps) {
  const dependents = preview.multi_step_sequences;
  const opName = preview.operation_name || sequenceLabel;
  return (
    <ModalBackdrop onClick={busy ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-operation-delete"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          Delete <span className="builderMono">{opName}</span>
        </h3>

        {dependents.length ? (
          <p style={{ margin: "0 0 10px" }}>
            This removes the one-step sequence and its STEP. These multi-step sequences
            still reference that STEP and will be <strong>suspended</strong> (they cannot run)
            until they are resaved with a valid STEP chain.
          </p>
        ) : (
          <p style={{ margin: "0 0 10px" }}>
            This deletes the one-step sequence and its STEP node. No other sequences
            reference it.
          </p>
        )}

        {dependents.length ? (
          <div className="builderFormFieldset">
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
              Sequences to be suspended:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {dependents.map((seq) => (
                <li key={seq.id}>{seq.name || seq.id}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="builderCheckMsg error">{error}</p> : null}

        <div className="builderModalActions">
          <button
            type="button"
            className="builderTinyBtn"
            data-testid="modal-cancel-btn"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btnDanger"
            data-testid="modal-confirm-btn"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Deleting…" : dependents.length ? "Delete & suspend" : "Delete"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
