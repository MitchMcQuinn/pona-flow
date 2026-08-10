import type { StepResponseParameter } from "../../../state/builder/types";
import { isValidParameterName } from "@pona-flow/authoring";

export function emptyStepResponseParameter(): StepResponseParameter {
  return { property_path: "", parameter: "", default_value: "" };
}

interface StepResponseParametersSectionProps {
  items: StepResponseParameter[];
  onChange: (items: StepResponseParameter[]) => void;
}

export function StepResponseParametersSection({
  items,
  onChange
}: StepResponseParametersSectionProps) {
  const rows = items.length > 0 ? items : [emptyStepResponseParameter()];

  function updateAt(index: number, patch: Partial<StepResponseParameter>) {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next);
  }

  function removeAt(index: number) {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : [emptyStepResponseParameter()]);
  }

  function addRow() {
    onChange([...rows, emptyStepResponseParameter()]);
  }

  return (
    <div className="builderField">
      <label>Response parameters</label>
      <p className="builderCheckMsg">
        Map JSON paths from the webhook response to parameter names. Default value is used when
        the response does not include a value at that path.
      </p>
      <div className="builderBlock" style={{ gap: 8 }}>
        {rows.map((row, index) => {
          const pathTrimmed = row.property_path.trim();
          const paramTrimmed = row.parameter.trim();
          const partialRow = Boolean(pathTrimmed || paramTrimmed);
          const paramInvalid = paramTrimmed !== "" && !isValidParameterName(paramTrimmed);
          const pathMissing = partialRow && !pathTrimmed;
          const paramMissing = partialRow && !paramTrimmed;

          return (
            <div className="builderCard nested builderItemRow" key={index}>
              <div className="builderRow">
                <div className="builderField">
                  <label>property path</label>
                  <input
                    className="builderMono"
                    placeholder="$.data.id"
                    value={row.property_path}
                    onChange={(e) => updateAt(index, { property_path: e.target.value })}
                  />
                  {pathMissing ? (
                    <span className="builderCheckMsg duplicate">property path is required</span>
                  ) : null}
                </div>
                <div className="builderField">
                  <label>parameter</label>
                  <input
                    className="builderMono"
                    placeholder="userId"
                    value={row.parameter}
                    onChange={(e) => updateAt(index, { parameter: e.target.value })}
                  />
                  {paramInvalid ? (
                    <span className="builderCheckMsg duplicate">
                      start with a letter or underscore; no leading digit
                    </span>
                  ) : null}
                  {paramMissing ? (
                    <span className="builderCheckMsg duplicate">parameter is required</span>
                  ) : null}
                </div>
                <div className="builderField">
                  <label>default value</label>
                  <input
                    placeholder="(optional fallback)"
                    value={row.default_value ?? ""}
                    onChange={(e) => updateAt(index, { default_value: e.target.value })}
                  />
                </div>
              </div>
              <div className="builderRowActions">
                <button
                  type="button"
                  className="builderTinyBtn builderDanger"
                  onClick={() => removeAt(index)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
        <div className="builderCardFooter">
          <button type="button" className="builderTinyBtn builderAddBtn" onClick={addRow}>
            + ADD RESPONSE PARAMETER
          </button>
        </div>
      </div>
    </div>
  );
}
