import { useState } from "react";
import type { StepDeletePreview } from "../../services/api";
import { ModalBackdrop } from "./ModalBackdrop";
import "../builder/builder.css";

export type SequenceDeleteMode = "nav" | "cascade";

interface SequenceDeleteConfirmModalProps {
  sequenceLabel: string;
  /**
   * Cascade blast radius for the "delete everything" option (resolved from the entry STEP).
   * Null when that STEP is missing from the graph — only a nav-only removal is available.
   */
  preview: StepDeletePreview | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (mode: SequenceDeleteMode) => void;
}

interface SummaryRow {
  key: string;
  count: number;
  singular: string;
  plural: string;
}

function cascadeRows(preview: StepDeletePreview): SummaryRow[] {
  const s = preview.summary;
  return [
    {
      key: "relationship_patterns",
      count: s.relationship_patterns,
      singular: "relationship pattern",
      plural: "relationship patterns"
    },
    { key: "sequences", count: s.sequences, singular: "dependent sequence", plural: "dependent sequences" }
  ].filter((row) => row.count > 0);
}

function namedList(items: Array<{ id: string; name: string }>): string {
  return items.map((item) => item.name || item.id).join(", ");
}

export function SequenceDeleteConfirmModal({
  sequenceLabel,
  preview,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: SequenceDeleteConfirmModalProps) {
  // Default to the least destructive option: only remove the definition from the nav.
  const [mode, setMode] = useState<SequenceDeleteMode>("nav");
  const orphaned = preview == null;
  const purge = preview?.mode === "purge";
  const rows = preview ? cascadeRows(preview) : [];

  const confirmLabel =
    mode === "nav"
      ? busy
        ? "Removing…"
        : "Remove from navigation"
      : busy
        ? purge
          ? "Deleting…"
          : "Removing…"
        : purge
          ? "Delete sequence & cascade"
          : "Remove from this space";

  return (
    <ModalBackdrop onClick={busy ? undefined : onCancel}>
      <div
        className="builderModalPanel"
        data-testid="modal-sequence-delete"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>
          Delete sequence <span className="builderMono">{sequenceLabel}</span>
        </h3>

        {orphaned ? (
          <p className="muted" data-testid="sequence-delete-orphan-hint" style={{ margin: "0 0 4px" }}>
            This sequence&rsquo;s entry STEP is missing from the graph, so a cascade delete
            isn&rsquo;t available. You can still remove the sequence definition from the
            navigation.
          </p>
        ) : null}

        <div className="sequenceDeleteOptions">
          <label className={`sequenceDeleteOption${mode === "nav" ? " active" : ""}`}>
            <input
              type="radio"
              name="sequence-delete-mode"
              value="nav"
              checked={mode === "nav"}
              disabled={busy}
              onChange={() => setMode("nav")}
            />
            <span>
              <strong>Remove from the navigation only</strong>
              <span className="sequenceDeleteOptionHint">
                Deletes just this sequence&rsquo;s definition. The underlying steps and graph
                patterns stay intact and can be reused by other sequences.
              </span>
            </span>
          </label>

          <label
            className={`sequenceDeleteOption${mode === "cascade" ? " active" : ""}${
              orphaned ? " unavailable" : ""
            }`}
          >
            <input
              type="radio"
              name="sequence-delete-mode"
              value="cascade"
              data-testid="sequence-delete-mode-cascade"
              checked={mode === "cascade"}
              disabled={busy || orphaned}
              onChange={() => setMode("cascade")}
            />
            <span>
              <strong>Delete the sequence and everything it depends on</strong>
              <span className="sequenceDeleteOptionHint">
                {orphaned ? (
                  <>Cascade is unavailable because the entry STEP no longer exists.</>
                ) : purge ? (
                  <>
                    Permanently removes the entry step, its relationship patterns, and every
                    dependent sequence. This cannot be undone.
                  </>
                ) : (
                  <>
                    This step is shared with other spaces, so the patterns stay intact — it is
                    only removed from this space&rsquo;s view.
                  </>
                )}
              </span>
            </span>
          </label>
        </div>

        {mode === "cascade" && preview && purge && rows.length ? (
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

        {mode === "cascade" && preview
          ? preview.warnings.map((warning, index) => (
              <p
                key={`${warning.type}-${index}`}
                className={`builderCheckMsg ${warning.requires_confirmation ? "error" : ""}`.trim()}
              >
                {warning.message}
              </p>
            ))
          : null}

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
            className={mode === "cascade" && purge ? "btnDanger" : "btnPrimary"}
            data-testid="modal-confirm-btn"
            disabled={busy}
            onClick={() => onConfirm(mode)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
