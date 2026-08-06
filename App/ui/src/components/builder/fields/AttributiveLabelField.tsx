import { useEffect, useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { attributiveLabelChanged } from "../../../state/builder/cardReset";
import { normalizeAttributiveLabel } from "../../../state/builder/normalizeField";
import type { GraphNodeLabel, NodePattern } from "../../../state/builder/types";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";
import { Picker } from "../Picker";

interface AttributiveLabelFieldProps {
  checkKey: string;
  label: GraphNodeLabel;
  attributiveLabel: string;
  excludeId?: string;
  // Whether uniqueness should be enforced (STEP/SCHEMA create on new nodes).
  enforceUnique: boolean;
  onChange: (value: string) => void;
  /** Fired on blur when the committed label differs from the value at focus (clears sibling fields). */
  onLabelCommitted?: (next: string, previous: string) => void;
  // Existing-node selection (nodes only). When provided, renders a picker.
  onSelectExisting?: (patch: Partial<NodePattern>) => void;
  allowExistingPicker?: boolean;
}

export function AttributiveLabelField({
  checkKey,
  label,
  attributiveLabel,
  excludeId,
  enforceUnique,
  onChange,
  onLabelCommitted,
  onSelectExisting,
  allowExistingPicker
}: AttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [existing, setExisting] = useState<Array<{ id: string; attributive_label: string }>>([]);
  const [labelAtFocus, setLabelAtFocus] = useState(attributiveLabel);

  useDebouncedCheck(
    checkKey,
    Boolean(enforceUnique && spaceId && attributiveLabel.trim()),
    `${spaceId}|${label}|${attributiveLabel}|${excludeId ?? ""}`,
    async () => {
      const exists = await connector.checkAttributiveLabelExists({
        spaceId,
        attributiveLabel: attributiveLabel.trim(),
        nodeLabel: label,
        excludeId
      });
      return exists
        ? { status: "duplicate", message: "already taken" }
        : { status: "ok", message: "valid" };
    }
  );

  useEffect(() => {
    if (!allowExistingPicker || !spaceId) return;
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel: label })
      .then((rows) => {
        if (!cancelled) {
          setExisting(rows.map((r) => ({ id: r.id, attributive_label: r.attributive_label })));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [allowExistingPicker, spaceId, label]);

  const check = state.checks[checkKey];

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <input
        value={attributiveLabel}
        onFocus={() => setLabelAtFocus(attributiveLabel)}
        onChange={(e) => onChange(normalizeAttributiveLabel(e.target.value))}
        onBlur={(e) => {
          const next = normalizeAttributiveLabel(e.target.value);
          if (onLabelCommitted && attributiveLabelChanged(labelAtFocus, next)) {
            onLabelCommitted(next, labelAtFocus);
          }
        }}
      />
      {check && check.status !== "idle" && enforceUnique ? (
        <span className={`builderCheckMsg ${check.status}`}>
          {check.status === "checking" ? "checking…" : check.message}
        </span>
      ) : null}

      {allowExistingPicker && onSelectExisting && existing.length > 0 ? (
        <Picker
          value=""
          placeholder={`— or reuse existing ${label} node —`}
          options={existing.map((row) => ({
            value: row.id,
            label: `${row.attributive_label} (${row.id.slice(0, 8)})`
          }))}
          onSelect={(value) => {
            const row = existing.find((x) => x.id === value);
            if (!row) return;
            onSelectExisting({
              node_source: "existing",
              attributive_label: row.attributive_label,
              id_binding: { key: "id", value: row.id }
            });
          }}
        />
      ) : null}
    </div>
  );
}
