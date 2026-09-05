import { ModalBackdrop } from "../../modals/ModalBackdrop";
import type { AffectedSequence } from "../../../services/connector";
import "../builder.css";

interface SchemaUpdateSuspendModalProps {
  attributiveLabel: string;
  added: string[];
  deleted: string[];
  /** Sequences that will be suspended (an INSTANCE step would no longer match the new pattern). */
  affectedSequences: AffectedSequence[];
  /** Standalone INSTANCE operations (not used by any sequence) that will be suspended. */
  affectedOperations: AffectedSequence[];
  /** Live INSTANCE nodes/relationships that will be marked out of sync (missing a new required prop). */
  outOfSyncInstanceCount: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation before an add/delete-only SCHEMA update that would break one or more sequences or
 * standalone operations, and/or leave live instances out of sync. Lists affected sequences/
 * operations (each suspended until its INSTANCE step is re-saved) and the count of instances that
 * will be flagged. Cancelling aborts the update entirely — nothing is persisted.
 */
export function SchemaUpdateSuspendModal({
  attributiveLabel,
  added,
  deleted,
  affectedSequences,
  affectedOperations,
  outOfSyncInstanceCount,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: SchemaUpdateSuspendModalProps) {
  const count = affectedSequences.length + affectedOperations.length;
  return (
    <ModalBackdrop onClick={busy ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-schema-update-suspend"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          Update schema <span className="builderMono">{attributiveLabel}</span>
        </h3>

        {count ? (
          <p style={{ margin: "0 0 10px" }}>
            This change affects {count} {count === 1 ? "item" : "items"}. They will be{" "}
            <strong>suspended</strong> and cannot run (for users or agents) until their INSTANCE
            step is re-saved to match the new schema pattern.
          </p>
        ) : (
          <p style={{ margin: "0 0 10px" }}>
            Confirm this add/delete-only change to the schema pattern.
          </p>
        )}

        {outOfSyncInstanceCount ? (
          <p style={{ margin: "0 0 10px" }}>
            <strong>{outOfSyncInstanceCount}</strong>{" "}
            {outOfSyncInstanceCount === 1 ? "instance" : "instances"} will be marked{" "}
            <strong>out of sync</strong> (missing the newly required property) until updated to
            match the new pattern.
          </p>
        ) : null}

        {added.length || deleted.length ? (
          <div className="builderFormFieldset">
            {added.length ? (
              <p className="muted" style={{ margin: "0 0 4px", fontSize: 12 }}>
                Added: {added.join(", ")}
              </p>
            ) : null}
            {deleted.length ? (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Removed: {deleted.join(", ")} (auto-removed from existing instances)
              </p>
            ) : null}
          </div>
        ) : null}

        {affectedSequences.length ? (
          <div className="builderFormFieldset">
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
              Sequences to be suspended:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {affectedSequences.map((seq) => (
                <li key={seq.id}>{seq.name || seq.id}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {affectedOperations.length ? (
          <div className="builderFormFieldset">
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
              Standalone queries to be suspended:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {affectedOperations.map((op) => (
                <li key={op.id}>{op.name || op.id}</li>
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
            {busy ? "Updating…" : count ? "Update & suspend" : "Update schema"}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
