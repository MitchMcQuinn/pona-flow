import type { RelationshipPattern } from "../../../state/builder/types";

interface StepRelConditionFieldProps {
  relationship: RelationshipPattern;
  readOnly: boolean;
  onPatch: (patch: Partial<RelationshipPattern>) => void;
}

// STEP relationship guard: a parameter name resolved from an earlier step's response.
// The transition runs only when that parameter coerces to the expected boolean
// ("true"/"1" -> true; "false"/"0"/anything else -> false). Two sibling
// relationships can therefore branch on a single parameter — one expecting true,
// the other expecting false. An unresolved parameter coerces to false.
export function StepRelConditionField({
  relationship,
  readOnly,
  onPatch
}: StepRelConditionFieldProps) {
  const isParameter = relationship.condition_type === "parameter";
  const value = isParameter ? relationship.condition ?? "" : "";
  const expected = relationship.condition_expected ?? true;

  if (readOnly) {
    return (
      <>
        <div className="builderField">
          <label>condition (parameter)</label>
          <input readOnly value={value} />
        </div>
        {isParameter ? (
          <div className="builderField">
            <label>expected result</label>
            <input readOnly value={expected ? "true" : "false"} />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="builderField">
        <label>condition (parameter)</label>
        <input
          className="builderMono"
          placeholder="$paramName from an earlier step's response"
          value={value}
          onChange={(e) => {
            const name = e.target.value.trim();
            onPatch(
              name
                ? {
                    condition_type: "parameter",
                    condition: name,
                    // Preserve an existing choice; default the true branch otherwise.
                    condition_expected: relationship.condition_expected ?? true
                  }
                : { condition_type: "null", condition: "", condition_expected: undefined }
            );
          }}
        />
      </div>
      {isParameter ? (
        <div className="builderField">
          <label>expected result</label>
          <select
            value={expected ? "true" : "false"}
            onChange={(e) => onPatch({ condition_expected: e.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      ) : null}
    </>
  );
}
