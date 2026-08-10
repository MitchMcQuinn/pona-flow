import { useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import {
  addParameter,
  removeParameter,
  updateParameterAt
} from "../../../state/builder/queryHelpers";
import { isValidParameterName } from "@pona-flow/authoring";
import { Toggle } from "../Toggle";
import type { DataType } from "../../../state/builder/types";

const DATA_TYPES: DataType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null"
];

// Query-level parameters surfaced inside the STEP node card (under body), the way
// the legacy form placed them next to their point of use in the request body.
export function StepParametersAccordion() {
  const { state, patchQuery } = useBuilder();
  const params = state.query.parameters;
  const [open, setOpen] = useState(params.length > 0);

  return (
    <div className="builderStepParams">
      <button
        type="button"
        className={"builderStepParamsToggle" + (open ? " is-open" : "")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Parameters{params.length ? ` (${params.length})` : ""}</span>
        <span className="builderStepParamsChevron" aria-hidden>
          ▸
        </span>
      </button>

      {open ? (
        <div className="builderStepParamsBody">
          <button
            type="button"
            className="builderTinyBtn builderAddBtn"
            onClick={() => {
              setOpen(true);
              patchQuery(addParameter());
            }}
          >
            + ADD PARAMETER
          </button>

          {params.length === 0 ? (
            <p className="builderCheckMsg">No parameters yet — add one to reference in the body.</p>
          ) : (
            params.map((param, index) => {
              const nameInvalid = param.name !== "" && !isValidParameterName(param.name);
              return (
                <div className="builderItemRow" key={index}>
                  <div className="builderRow">
                    <div className="builderField">
                      <label>name</label>
                      <input
                        className="builderMono"
                        placeholder="personId"
                        value={param.name}
                        onChange={(e) =>
                          patchQuery(updateParameterAt(index, { name: e.target.value }))
                        }
                      />
                      {nameInvalid ? (
                        <span className="builderCheckMsg duplicate">
                          start with a letter or underscore; no leading digit
                        </span>
                      ) : null}
                    </div>
                    <div className="builderField">
                      <label>data_type</label>
                      <select
                        value={param.data_type}
                        onChange={(e) =>
                          patchQuery(
                            updateParameterAt(index, { data_type: e.target.value as DataType })
                          )
                        }
                      >
                        {DATA_TYPES.map((dt) => (
                          <option key={dt} value={dt}>
                            {dt}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="builderField">
                      <label>default value</label>
                      <input
                        value={String(param.value ?? "")}
                        onChange={(e) =>
                          patchQuery(updateParameterAt(index, { value: e.target.value }))
                        }
                      />
                    </div>
                    <div className="builderField">
                      <Toggle
                        checked={param.is_required === true}
                        onChange={(checked) =>
                          patchQuery(updateParameterAt(index, { is_required: checked }))
                        }
                        label="required"
                      />
                    </div>
                  </div>
                  <div className="builderRowActions">
                    <button
                      type="button"
                      className="builderTinyBtn builderDanger"
                      onClick={() => patchQuery(removeParameter(param.name))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })
          )}

          <p className="builderCheckMsg">
            Use $name in the body JSON (e.g. "userId": "$personId").
          </p>
        </div>
      ) : null}
    </div>
  );
}
