import type { SchemaDeletePreview } from "../../../services/api";
import { ModalBackdrop } from "../../modals/ModalBackdrop";

interface SchemaDeleteConfirmModalProps {
  preview: SchemaDeletePreview;
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

function summaryRows(preview: SchemaDeletePreview): SummaryRow[] {
  const s = preview.summary;
  return [
    { key: "instances", count: s.instances, singular: "instance", plural: "instances" },
    {
      key: "relationship_patterns",
      count: s.relationship_patterns,
      singular: "relationship pattern",
      plural: "relationship patterns"
    },
    { key: "queries", count: s.queries, singular: "query", plural: "queries" },
    { key: "sequences", count: s.sequences, singular: "sequence", plural: "sequences" },
    { key: "steps", count: s.steps, singular: "step", plural: "steps" }
  ].filter((row) => row.count > 0);
}

function namedList(items: Array<{ id: string; name: string }>): string {
  return items.map((item) => item.name || item.id).join(", ");
}

export function SchemaDeleteConfirmModal({
  preview,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: SchemaDeleteConfirmModalProps) {
  const purge = preview.mode === "purge";
  const rows = summaryRows(preview);
  const confirmLabel = purge ? "Delete schema & cascade" : "Remove from this space";
  const busyLabel = purge ? "Deleting…" : "Removing…";

  return (
    <ModalBackdrop onClick={busy ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-schema-delete"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          Delete schema <span className="builderMono">{preview.attributive_label}</span>
        </h3>

        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {purge ? (
            <>
              No other space references this schema, so it will be{" "}
              <strong>permanently deleted</strong> along with everything that depends on it
              (below). This cannot be undone.
            </>
          ) : (
            <>
              This schema is shared with other spaces, so the patterns stay intact. It will
              only be <strong>removed from this space&rsquo;s view</strong>.
            </>
          )}
        </p>

        {purge && rows.length ? (
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
            {preview.affected.queries.length ? (
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Queries: {namedList(preview.affected.queries)}
              </p>
            ) : null}
            {preview.affected.sequences.length ? (
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Sequences: {namedList(preview.affected.sequences)}
              </p>
            ) : null}
          </div>
        ) : null}

        {purge && !rows.length ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Only the schema node itself will be removed; nothing else references it.
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
            className={purge ? "btnDanger" : "btnPrimary"}
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
