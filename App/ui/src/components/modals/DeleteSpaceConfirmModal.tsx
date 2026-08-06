import { ModalBackdrop } from "./ModalBackdrop";
import "../builder/builder.css";

interface DeleteSpaceConfirmModalProps {
  spaceName: string;
  saving?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteSpaceConfirmModal({
  spaceName,
  saving = false,
  error = null,
  onCancel,
  onConfirm
}: DeleteSpaceConfirmModalProps) {
  return (
    <ModalBackdrop onClick={saving ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-delete-space"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>Delete space</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Are you sure you want to delete <strong>{spaceName}</strong>? This removes the space
          from the catalog; it does not delete Neo4j or SQLite data files.
        </p>
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
            data-testid="modal-confirm-btn"
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? "Deleting…" : "Delete space"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
