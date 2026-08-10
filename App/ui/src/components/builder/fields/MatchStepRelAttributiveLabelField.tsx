import { useEffect, useMemo, useState } from "react";
import {
  isRegisteredInSpaceCatalog,
  spaceCatalogLabelKeys
} from "../../../state/builder/attributiveLabelOptions";
import { normalizeAttributiveLabel } from "@pona-flow/authoring";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector, { type StepOutgoingEdge } from "../../../services/connector";
import { Picker } from "../Picker";
import { AddParameterModal } from "../modals/AddParameterModal";

interface MatchStepRelAttributiveLabelFieldProps {
  /** STEP node attributive_label that owns outgoing edges for this hop. */
  parentAttributiveLabel: string;
  attributiveLabel: string;
  /** Following node's attributive_label — disambiguates siblings sharing a rel label. */
  targetAttributiveLabel?: string;
  disabled?: boolean;
  onSelect: (attributiveLabel: string, edge: StepOutgoingEdge) => void;
  /** Set the attributive_label to a $parameter instead of binding an edge. */
  onSelectParameter: (parameter: string) => void;
}

// Read / update / delete STEP match: pick a POINTS_TO edge outbound from the parent STEP node.
export function MatchStepRelAttributiveLabelField({
  parentAttributiveLabel,
  attributiveLabel,
  targetAttributiveLabel = "",
  disabled = false,
  onSelect,
  onSelectParameter
}: MatchStepRelAttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [edges, setEdges] = useState<StepOutgoingEdge[]>([]);
  const [graphUnavailable, setGraphUnavailable] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);
  const parentKey = normalizeAttributiveLabel(parentAttributiveLabel);

  useEffect(() => {
    if (!spaceId || !parentKey) {
      setEdges([]);
      setGraphUnavailable(false);
      return;
    }
    let cancelled = false;
    connector
      .fetchGraphStepOutgoing({ spaceId, attributiveLabel: parentAttributiveLabel })
      .then((rows) => {
        if (cancelled) return;
        setGraphUnavailable(false);
        setEdges(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setGraphUnavailable(true);
        setEdges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, parentAttributiveLabel, parentKey]);

  const catalogKeys = useMemo(
    () => spaceCatalogLabelKeys(state.spaceLabels),
    [state.spaceLabels]
  );

  const catalogEdges = useMemo(
    () =>
      edges.filter(
        (edge) =>
          isRegisteredInSpaceCatalog(edge.rel_attributive_label, catalogKeys) &&
          isRegisteredInSpaceCatalog(edge.target_attributive_label, catalogKeys)
      ),
    [edges, catalogKeys]
  );

  const options = useMemo(() => {
    const relCounts = new Map<string, number>();
    for (const edge of catalogEdges) {
      const relAl = edge.rel_attributive_label?.trim();
      if (!relAl) continue;
      relCounts.set(relAl, (relCounts.get(relAl) ?? 0) + 1);
    }
    const list: Array<{ value: string; label: string; edge: StepOutgoingEdge }> = [];
    for (const edge of catalogEdges) {
      const relAl = edge.rel_attributive_label?.trim();
      const targetAl = edge.target_attributive_label?.trim();
      if (!relAl || !targetAl) continue;
      const ambiguous = (relCounts.get(relAl) ?? 0) > 1;
      const value = ambiguous ? `${relAl}|${targetAl}` : relAl;
      const label = ambiguous ? `${relAl} → ${targetAl}` : relAl;
      if (list.some((o) => o.value === value)) continue;
      list.push({ value, label, edge });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [catalogEdges]);

  // The stored attributive_label is the bare rel label; reconstruct the picker's
  // (possibly composite) option value so the selected sibling shows its target.
  const selectedValue = useMemo(() => {
    const relAl = attributiveLabel.trim();
    if (!relAl) return attributiveLabel;
    const target = targetAttributiveLabel.trim();
    const exact = options.find(
      (o) =>
        o.edge.rel_attributive_label?.trim() === relAl &&
        o.edge.target_attributive_label?.trim() === target
    );
    if (exact) return exact.value;
    const byRel = options.find((o) => o.edge.rel_attributive_label?.trim() === relAl);
    return byRel ? byRel.value : attributiveLabel;
  }, [options, attributiveLabel, targetAttributiveLabel]);

  const hasGraphEdges = edges.length > 0;
  const hasCatalogOverlap = catalogEdges.length > 0;

  const emptyHint = !parentKey
    ? "Select the preceding STEP node's attributive_label first."
    : graphUnavailable
      ? "Could not load outbound relationships from the graph. Check the space Neo4j connection."
      : hasGraphEdges && !hasCatalogOverlap
        ? "Outbound relationships exist in the graph but none are listed in this space's label catalog."
        : "No outbound STEP relationships from this node in both the graph and label catalog.";

  return (
    <div className="builderField">
      <label>attributive_label</label>
      <Picker
        value={selectedValue}
        placeholder="(select relationship)"
        options={options.map((o) => ({ value: o.value, label: o.label }))}
        createActions={[{ label: "+ ADD A PARAMETER", onClick: () => setShowParamModal(true) }]}
        onSelect={(value) => {
          const match = options.find((o) => o.value === value);
          if (match) onSelect(value, match.edge);
        }}
        disabled={disabled || !parentKey}
        emptyHint={emptyHint}
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
