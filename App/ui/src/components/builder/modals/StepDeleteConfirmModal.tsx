import type { StepDeletePreview } from "../../../services/api";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface StepDeleteConfirmModalProps {
  preview: StepDeletePreview;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

interface SummaryRow {
  key: string;
  count: number;
  singular: string;
  plural: string;
}

function summaryRows(preview: StepDeletePreview): SummaryRow[] {
  const s = preview.summary;
  return [
    {
      key: "relationship_patterns",
      count: s.relationship_patterns,
      singular: "relationship pattern",
      plural: "relationship patterns"
    },
    { key: "sequences", count: s.sequences, singular: "sequence", plural: "sequences" }
  ].filter((row) => row.count > 0);
}

function namedList(items: Array<{ id: string; name: string }>): string {
  return items.map((item) => item.name || item.id).join(", ");
}

export function StepDeleteConfirmModal({
  preview,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: StepDeleteConfirmModalProps) {
  const rows = summaryRows(preview);
  const confirmLabel = "Delete step & cascade";
  const busyLabel = "Deleting…";

  return (
    <ModalBackdrop onClick={busy ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-step-delete"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          Delete step <span className="builderMono">{preview.attributive_label}</span>
        </h3>

        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          This step will be <strong>permanently deleted</strong> along with every sequence
          that depends on it (below). This cannot be undone.
        </p>

        {rows.length ? (
          <div className="builderFormFieldset">
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
              The following will be deleted:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {rows.map((row) => (
                <li key={row.key}>
                  <strong>{row.count}</strong> {row.count === 1 ? row.singular : row.plural}
                </li>
              ))}
            </ul>
            {preview.affected.sequences.length ? (
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Sequences: {namedList(preview.affected.sequences)}
              </p>
            ) : null}
          </div>
        ) : null}

        {!rows.length ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Only the step itself will be removed; no sequences depend on it.
          </p>
        ) : null}

        {preview.warnings.map((warning, index) => (
          <p
            key={`${warning.type}-${index}`}
            className={`builderCheckMsg ${warning.requires_confirmation ? "error" : ""}`.trim()}
          >
            {warning.message}
          </p>
        ))}

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
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
