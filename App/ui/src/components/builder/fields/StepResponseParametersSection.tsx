import type { StepResponseParameter } from "../../../state/builder/types";
import { isValidParameterName } from "@pona-flow/authoring";
import { FieldLabel, FieldTip } from "../FieldTip";

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
      <div className="createSequenceLabelRow">
        <h2 className="builderPanelTitle">response parameters</h2>
        <FieldTip text="Map JSON paths from the response to parameter names. The default is used when that path is missing." />
      </div>
      <div className="builderBlock">
        {rows.map((row, index) => {
          const pathTrimmed = row.property_path.trim();
          const paramTrimmed = row.parameter.trim();
          const partialRow = Boolean(pathTrimmed || paramTrimmed);
          const paramInvalid = paramTrimmed !== "" && !isValidParameterName(paramTrimmed);
          const pathMissing = partialRow && !pathTrimmed;
          const paramMissing = partialRow && !paramTrimmed;
          const nameMissing = paramMissing || paramInvalid;

          return (
            <div
              className="builderCard nested builderItemRow builderParameterCard builderParameterCardRemovable"
              key={index}
            >
              <button
                type="button"
                className="builderPropertyRemove"
                aria-label="Remove response parameter"
                title="Remove response parameter"
                onClick={() => removeAt(index)}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path
                    d="M2 2 L10 10 M10 2 L2 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <div
                className={
                  nameMissing
                    ? "builderField builderFieldMissing builderPropertyName"
                    : "builderField builderPropertyName"
                }
              >
                <input
                  className="builderPropertyNameInput"
                  aria-label="parameter"
                  placeholder="name"
                  value={row.parameter}
                  onChange={(e) => updateAt(index, { parameter: e.target.value })}
                />
                {paramInvalid ? (
                  <span className="builderCheckMsg duplicate">
                    start with a letter or underscore; no leading digit
                  </span>
                ) : paramMissing ? (
                  <span className="builderCheckMsg duplicate">parameter is required</span>
                ) : null}
              </div>
              <div className="builderPropertyTypeRow">
                <div className="builderField">
                  <FieldLabel tip="JSON path in the response body, for example $.data.id.">
                    property path
                  </FieldLabel>
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
                  <FieldLabel tip="Used when the response does not include a value at that path.">
                    default value
                  </FieldLabel>
                  <input
                    placeholder="(optional fallback)"
                    value={row.default_value ?? ""}
                    onChange={(e) => updateAt(index, { default_value: e.target.value })}
                  />
                </div>
              </div>
            </div>
          );
        })}
        <div className="builderCardFooter">
          <button
            type="button"
            className="builderTinyBtn builderAddBtn builderAddParameterBtn"
            onClick={addRow}
          >
            + Add response parameter
          </button>
        </div>
      </div>
    </div>
  );
}
