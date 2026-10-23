import { useEffect, useState } from "react";
import { attributiveLabelChanged } from "../../../state/builder/cardReset";
import { isRegisteredInSpaceCatalog, spaceCatalogLabelKeys } from "../../../state/builder/attributiveLabelOptions";
import { isAttributiveLabelParameter } from "@pona-flow/authoring";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import type { GraphNodeLabel, SequencialProperties } from "../../../state/builder/types";
import { Picker } from "../Picker";
import { InlineCreateNameField, type InlineCreateKind } from "./InlineCreateNameField";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";

export interface ExistingStepNode {
  id: string;
  attributive_label: string;
  sequencial_properties?: SequencialProperties;
}

interface StepAttributiveLabelFieldProps {
  attributiveLabel: string;
  disabled: boolean;
  // Real-time uniqueness validation (new nodes only).
  checkKey: string;
  excludeId?: string;
  enforceUnique: boolean;
  // Graph node label whose existing nodes populate the picker (STEP or SCHEMA).
  nodeLabel?: GraphNodeLabel;
  onSelectNew: (attributiveLabel: string) => void;
  onSelectExisting: (record: ExistingStepNode) => void;
}

export function StepAttributiveLabelField({
  attributiveLabel,
  disabled,
  checkKey,
  excludeId,
  enforceUnique,
  nodeLabel = "STEP",
  onSelectNew,
  onSelectExisting
}: StepAttributiveLabelFieldProps) {
  const { state } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const [existing, setExisting] = useState<ExistingStepNode[]>([]);
  const [createKind, setCreateKind] = useState<InlineCreateKind | null>(null);
  // Custom-endpoint STEP creates MERGE a concrete graph identity, so attributive_label
  // cannot be a $parameter. SCHEMA create still allows one (meta-authoring).
  const allowParameter = nodeLabel !== "STEP";

  // Globally unique across STEP/SCHEMA nodes and SCHEMA relationship types.
  // A $parameter label is validated against its default value in the parameters card.
  const isParameterLabel = isAttributiveLabelParameter(attributiveLabel);
  useDebouncedCheck(
    checkKey,
    Boolean(enforceUnique && spaceId && attributiveLabel.trim() && !isParameterLabel),
    `${spaceId}|${attributiveLabel}|${excludeId ?? ""}`,
    async () => {
      const taken = await connector.checkAttributiveLabelExists({
        spaceId,
        attributiveLabel: attributiveLabel.trim(),
        nodeLabel,
        excludeId
      });
      return taken
        ? { status: "duplicate", message: "already taken" }
        : { status: "ok", message: "valid" };
    }
  );

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    connector
      .fetchGraphNodesByLabel({ spaceId, nodeLabel })
      .then((rows) => {
        if (!cancelled) setExisting(rows as ExistingStepNode[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // state.dataVersion: refetch after a mutation so newly created nodes appear.
  }, [spaceId, nodeLabel, state.dataVersion]);

  // Only surface existing STEP nodes whose attributive_label is registered in the
  // selected space's label column (spaces.labels), mirroring the old form.
  const catalogKeys = spaceCatalogLabelKeys(state.spaceLabels);
  const options = existing
    .filter((n) => isRegisteredInSpaceCatalog(n.attributive_label, catalogKeys))
    .map((n) => ({ value: n.attributive_label, label: n.attributive_label }));

  const check = state.checks[checkKey];
  const showCheck =
    enforceUnique &&
    !isParameterLabel &&
    check &&
    (check.status === "duplicate" || check.status === "error" || check.status === "checking");

  const missing = !attributiveLabel.trim() || Boolean(createKind);

  return (
    <div
      className={missing ? "builderField builderFieldMissing" : "builderField"}
      data-issue="attributive_label"
      data-check={check?.status ?? "idle"}
    >
      {showCheck ? (
        <span className={`builderCheckMsg ${check.status}`}>
          {check.status === "checking" ? "checking…" : check.message}
        </span>
      ) : null}
      {createKind ? (
        <InlineCreateNameField
          kind={createKind}
          className="builderTitleInput"
          onCommit={(value) => {
            setCreateKind(null);
            onSelectNew(value);
          }}
          onCancel={() => setCreateKind(null)}
        />
      ) : (
        <Picker
          className="builderPickerAsTitle"
          value={attributiveLabel}
          placeholder="select or create node"
          options={options}
          createActions={[
            { label: "+ ADD NEW NODE", onClick: () => setCreateKind("node") },
            ...(allowParameter
              ? [{ label: "+ ADD A PARAMETER", onClick: () => setCreateKind("parameter") }]
              : [])
          ]}
          onSelect={(value) => {
            if (!attributiveLabelChanged(attributiveLabel, value)) return;
            const rec = existing.find((n) => n.attributive_label === value);
            if (rec) onSelectExisting(rec);
          }}
          disabled={disabled}
          title={disabled ? "Locked because this entry has an alias." : undefined}
          emptyHint={
            nodeLabel === "SCHEMA"
              ? "No schema nodes available"
              : `No ${nodeLabel} nodes in both the graph and this space's label catalog.`
          }
        />
      )}
    </div>
  );
}
