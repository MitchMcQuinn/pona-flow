import { useState, type ReactNode } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import { setReturnDistinct, updateMatchClause } from "../../state/builder/queryHelpers";
import { showMatchOptionalControls } from "@pona-flow/authoring";
import { OrderPaginationSection } from "./OrderPaginationSection";
import { Toggle } from "./Toggle";

function AdvancedOptionsAccordion({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="builderStepParams">
      <button
        type="button"
        className={"builderStepParamsToggle" + (open ? " is-open" : "")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Advanced options</span>
        <span className="builderStepParamsChevron" aria-hidden>
          ▸
        </span>
      </button>

      {open ? <div className="builderStepParamsBody">{children}</div> : null}
    </div>
  );
}

function MatchOptionalToggles() {
  const { state, patchQuery } = useBuilder();

  return (
    <>
      {state.query.match.map((clause, clauseIndex) => {
        if (clauseIndex === 0) return null;
        return (
          <div className="builderField" key={clauseIndex}>
            <Toggle
              checked={clause.optional ?? false}
              onChange={(value) => patchQuery(updateMatchClause(clauseIndex, { optional: value }))}
              label={`OPTIONAL (${clause.label})`}
              labelFirst
            />
          </div>
        );
      })}
    </>
  );
}

function CreateAdvancedOptionsBody() {
  const { state, dispatch } = useBuilder();

  return (
    <div className="builderField">
      <label>duplicates</label>
      <select
        value={state.query.allow_duplicates ? "create" : "merge"}
        onChange={(e) =>
          dispatch({
            type: "UPDATE_QUERY",
            updater: (q) => ({ ...q, allow_duplicates: e.target.value === "create" })
          })
        }
      >
        <option value="merge">MERGE (dedupe)</option>
        <option value="create">CREATE (allow dupes)</option>
      </select>
    </div>
  );
}

function ReadAdvancedOptionsBody() {
  const { state, patchQuery } = useBuilder();
  const distinct = state.query.return?.distinct ?? false;

  return (
    <>
      <div className="builderField">
        <Toggle
          checked={distinct}
          onChange={(value) => patchQuery(setReturnDistinct(value))}
          label="DISTINCT"
          labelFirst
        />
      </div>
      <OrderPaginationSection nested />
    </>
  );
}

export function AdvancedOptions() {
  const { state } = useBuilder();
  const op = state.query.operation;
  const showOptional = showMatchOptionalControls(state.query.match.length, op);

  if (op === "create") {
    return (
      <AdvancedOptionsAccordion>
        <CreateAdvancedOptionsBody />
      </AdvancedOptionsAccordion>
    );
  }

  if (op === "read") {
    // Read SCHEMA and read STEP are traversal flows without the schema-bound
    // DISTINCT / ORDER BY / pagination controls, so the accordion is hidden there.
    const label = state.query.match[0]?.label;
    if (label === "SCHEMA" || label === "STEP") {
      return null;
    }
    return (
      <AdvancedOptionsAccordion>
        <ReadAdvancedOptionsBody />
        {showOptional ? <MatchOptionalToggles /> : null}
      </AdvancedOptionsAccordion>
    );
  }

  if (showOptional) {
    return (
      <AdvancedOptionsAccordion>
        <MatchOptionalToggles />
      </AdvancedOptionsAccordion>
    );
  }

  return null;
}
