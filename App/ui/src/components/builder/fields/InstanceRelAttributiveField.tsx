import { useEffect, useState } from "react";
import {
  isRegisteredInSpaceCatalog,
  spaceCatalogLabelKeys
} from "../../../state/builder/attributiveLabelOptions";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import type { SchemaOutgoingEdge } from "../../../services/connector";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

interface InstanceRelAttributiveFieldProps {
  parentAttributiveLabel: string;
  attributiveLabel: string;
  /** Current hop direction on the relationship ("outgoing" when omitted). */
  direction?: "outgoing" | "incoming";
  /** Match ops: also offer edges pointing AT the parent node (reverse hops). */
  includeIncoming?: boolean;
  disabled: boolean;
  onSelect: (edge: SchemaOutgoingEdge) => void;
  /** Set the attributive_label to a $parameter instead of binding an edge. */
  onSelectParameter: (parameter: string) => void;
}

// INSTANCE relationship: attributive_label is constrained to a POINTS_TO edge of the
// preceding node's SCHEMA — outgoing edges always, incoming edges too for match ops.
// Each option also fixes the target node (the node on the edge's other end).
export function InstanceRelAttributiveField({
  parentAttributiveLabel,
  attributiveLabel,
  direction,
  includeIncoming = false,
  disabled,
  onSelect,
  onSelectParameter
}: InstanceRelAttributiveFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [edges, setEdges] = useState<SchemaOutgoingEdge[]>([]);
  const [showParamModal, setShowParamModal] = useState(false);

  useEffect(() => {
    if (!spaceId || !parentAttributiveLabel) {
      setEdges([]);
      return;
    }
    let cancelled = false;
    connector
      .fetchSchemaOutgoing({
        spaceId,
        attributiveLabel: parentAttributiveLabel,
        includeIncoming
      })
      .then((rows) => {
        if (!cancelled) setEdges(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [spaceId, parentAttributiveLabel, includeIncoming]);

  const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
  const catalogEdges = edges.filter(
    (e) =>
      isRegisteredInSpaceCatalog(e.rel_attributive_label, catalogKeys) &&
      isRegisteredInSpaceCatalog(e.target_attributive_label, catalogKeys)
  );

  // An incoming edge points AT the parent: "REL ← OTHER" mirrors the graph arrow.
  const options = catalogEdges.map((e, i) => ({
    value: String(i),
    label:
      e.direction === "incoming"
        ? `${e.rel_attributive_label} ← ${e.target_attributive_label}`
        : `${e.rel_attributive_label} → ${e.target_attributive_label}`
  }));
  // The same rel label can exist in both directions, so selection matches on both.
  const currentDirection = direction === "incoming" ? "incoming" : "outgoing";
  const selectedIndex = catalogEdges.findIndex(
    (e) =>
      e.rel_attributive_label === attributiveLabel &&
      (e.direction === "incoming" ? "incoming" : "outgoing") === currentDirection
  );

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={selectedIndex >= 0 ? String(selectedIndex) : attributiveLabel}
        placeholder="(select relationship)"
        options={options}
        createActions={[{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]}
        onSelect={(value) => {
          const edge = catalogEdges[Number(value)];
          if (edge) onSelect(edge);
        }}
        disabled={disabled}
        title={disabled ? "Locked because this entry has an alias." : undefined}
        emptyHint="No outgoing relationships in both the graph and this space's label catalog."
      />
      {showParamModal ? (
        <AddParameterModal
          onCancel={() => setShowParamModal(false)}
          onSave={(param) => {
            setShowParamModal(false);
            onSelectParameter(param);
          }}
        />
      ) : null}
    </div>
  );
}
