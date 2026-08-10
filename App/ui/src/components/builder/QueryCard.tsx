import { useEffect } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import { hasReferencedParameters } from "@pona-flow/authoring";
import { syncParametersFromReferences } from "@pona-flow/authoring";
import { DeleteSection } from "./DeleteSection";
import { LabelSelect } from "./LabelSelect";
import { MatchSection } from "./match/MatchSection";
import { OperationSelect } from "./OperationSelect";
import { ParametersSection } from "./ParametersSection";
import { ReturnSection } from "./ReturnSection";
import { SetSection } from "./SetSection";
import { isEntityConfigUpdate, isLabelOnlyDelete } from "@pona-flow/authoring";

export function QueryCard() {
  const { state, patchQuery } = useBuilder();
  const { query } = state;
  const op = query.operation;
  const clauseLabel = query.match[0]?.label;
  const showParameters = hasReferencedParameters(query);
  // Update SCHEMA/STEP only edits entity config payloads (SQLite); the graph-clause
  // cards (WHERE/SET/RETURN) don't apply.
  const entityConfigUpdate = isEntityConfigUpdate(op, clauseLabel);
  // Delete STEP/SCHEMA needs no Delete card: it always DETACH DELETEs every matched
  // node/relationship (the target inputs and DETACH toggle would be redundant).
  const labelOnlyDelete = isLabelOnlyDelete(op, clauseLabel);
  // Graph vs entity-config card stack — only this boundary needs a enter transition on
  // the match clause (routine op/label changes keep the same graph builder mounted).
  const matchSectionKey = entityConfigUpdate
    ? `entity-config-${clauseLabel ?? ""}`
    : "match-graph";

  useEffect(() => {
    patchQuery((q) => syncParametersFromReferences(q));
  }, [query, patchQuery]);

  return (
    <div className="builderQueryForm">
      <div className="builderRow">
        <OperationSelect />
      </div>

      <div className="builderRow">
        <LabelSelect />
      </div>

      <div className="builderFormTransition" key={matchSectionKey}>
        <MatchSection />
      </div>

      <div className="builderFormTransition" key={`${op}-${clauseLabel ?? ""}-sections`}>
        {op === "read" ? <ReturnSection /> : null}
        {op === "update" && !entityConfigUpdate ? (
          <>
            <SetSection />
            <ReturnSection />
          </>
        ) : null}
        {op === "delete" && !labelOnlyDelete ? <DeleteSection /> : null}

        {showParameters ? <ParametersSection /> : null}
      </div>
    </div>
  );
}
