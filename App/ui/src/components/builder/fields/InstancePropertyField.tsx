import { useState } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import connector from "../../../services/connector";
import { updateProperty } from "../../../state/builder/queryHelpers";
import { newSchematicProperties } from "../../../state/builder/defaults";
import { isSchemaNullRaw, validateInstanceValue } from "../../../state/builder/schemaRules";
import { extractExactParameterRef } from "../../../state/builder/parameterRefs";
import type { PropertyBinding as PropertyBindingType } from "../../../state/builder/types";
import { useDebouncedCheck } from "../hooks/useDebouncedCheck";
import { TypedValueInput } from "./TypedValueInput";

interface InstancePropertyFieldProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  propIndex: number;
  prop: PropertyBindingType;
  attributiveLabel: string;
  excludeId?: string;
  /** INSTANCE create: hide is_key (graph id) until the user sets an explicit alias. */
  hidden?: boolean;
}

// INSTANCE property: key/constraints are adopted (read-only) from the SCHEMA. Only
// the value is editable, validated against value_type/format and (for is_key) graph
// uniqueness. UID fields are minted by the engine at run time and stay locked.
export function InstancePropertyField({
  clauseIndex,
  patternIndex,
  pathIndex,
  propIndex,
  prop,
  attributiveLabel,
  excludeId,
  hidden = false
}: InstancePropertyFieldProps) {
  const { state, patchQuery } = useBuilder();
  const schema = prop.schematic_properties ?? newSchematicProperties();
  const raw = String(prop.value ?? "");
  const isUid = schema.value_type === "UID";
  // UID keys are minted by the engine each run (the composer binds them to an
  // `id__<alias>` parameter), so the field never holds an author-time value.
  // Non-key/non-UID properties can be supplied at run time by typing an exact $param
  // reference into their value — auto-recognized like attributive_label and the other
  // builder fields. The referenced parameter then inherits this property's schema
  // config (see parameterRefs).
  const paramRef = !isUid && !schema.is_key ? extractExactParameterRef(raw) : null;
  const usingParameter = Boolean(paramRef);

  // boolean/radio/checkbox collect values through constrained controls (dropdown /
  // checklist) with no free-text path, so they need an explicit toggle to switch the
  // field into $param entry mode. Free-text types accept $param directly.
  const isConstrainedType =
    schema.value_type === "boolean" ||
    schema.value_type === "radio" ||
    schema.value_type === "checkbox";
  const canUseParameter = !isUid && !schema.is_key;
  const [paramMode, setParamMode] = useState(false);
  const parameterEntryActive = canUseParameter && isConstrainedType && (paramMode || usingParameter);

  const valueCheck = usingParameter
    ? { valid: true, message: "" }
    : parameterEntryActive
      ? isSchemaNullRaw(raw)
        ? { valid: !schema.is_required, message: schema.is_required ? "required" : "" }
        : { valid: false, message: "must be an exact $param reference" }
      : validateInstanceValue(schema, raw);

  const setValue = (next: string) =>
    patchQuery(updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, { value: next }));

  const toggleParameterEntry = () => {
    if (parameterEntryActive) {
      setParamMode(false);
      // Leaving $param mode: discard any text the constrained control can't represent
      // (a $param reference or a half-typed value) so it doesn't linger in the query.
      if (extractExactParameterRef(raw) || !validateInstanceValue(schema, raw).valid) {
        setValue("");
      }
    } else {
      setParamMode(true);
    }
  };

  const flags = [
    schema.is_key ? "key" : null,
    schema.is_label ? "label" : null,
    schema.is_required ? "required" : null,
    schema.is_indexed ? "indexed" : null
  ].filter(Boolean);

  const keyCheckKey = `ikey:${clauseIndex}:${patternIndex}:${pathIndex}:${propIndex}`;
  // Non-UID is_key values must be unique among INSTANCE nodes of the same
  // attributive_label. UID keys are minted fresh each run, so there is nothing to check.
  useDebouncedCheck(
    keyCheckKey,
    Boolean(
      schema.is_key &&
        !isUid &&
        state.spaceId &&
        attributiveLabel &&
        prop.key &&
        valueCheck.valid &&
        !isSchemaNullRaw(raw)
    ),
    `${state.spaceId ?? ""}|${attributiveLabel}|${prop.key}|${raw}|${excludeId ?? ""}`,
    async () => {
      const exists = await connector.checkInstancePropertyExists({
        spaceId: state.spaceId ?? "",
        attributiveLabel,
        propertyKey: prop.key,
        value: raw,
        excludeId
      });
      return exists
        ? { status: "duplicate", message: "already taken" }
        : { status: "ok", message: "unique" };
    }
  );

  const keyCheck = schema.is_key ? state.checks[keyCheckKey] : undefined;

  // No label or input in the tree; effects above still autofill UID is_key values.
  if (hidden) {
    return null;
  }

  const control = (
    <TypedValueInput
      // $param entry mode: swap the constrained control for free text so an
      // exact $name can be typed (the parameter inherits this property's schema).
      valueType={parameterEntryActive ? "string" : schema.value_type}
      options={schema.options}
      minChoices={schema.min_choices}
      maxChoices={schema.max_choices}
      required={schema.is_required}
      value={raw}
      readOnly={isUid}
      placeholder={
        isUid
          ? "(generated at run time)"
          : parameterEntryActive
            ? "($param reference)"
            : schema.is_required
              ? "(required, or $param)"
              : "(optional, or $param)"
      }
      title={isUid ? "A fresh UID is generated by the engine on every run." : undefined}
      onChange={setValue}
    />
  );

  return (
    <div className="builderField">
      <label>
        <span className="builderMono">{prop.key}</span>
        <span className="builderMuted">
          {" "}
          ({schema.value_type}
          {flags.length ? `, ${flags.join(", ")}` : ""})
        </span>
        {usingParameter ? (
          <span className="builderCheckMsg ok"> parameter (supplied at run time)</span>
        ) : !valueCheck.valid ? (
          <span className="builderCheckMsg duplicate"> {valueCheck.message}</span>
        ) : keyCheck && keyCheck.status !== "idle" ? (
          <span className={`builderCheckMsg ${keyCheck.status}`}>
            {" "}
            {keyCheck.status === "checking" ? "checking…" : keyCheck.message}
          </span>
        ) : null}
      </label>
      {canUseParameter && isConstrainedType ? (
        <div className="builderValueWithParamToggle">
          {control}
          <button
            type="button"
            className={`builderTinyBtn${parameterEntryActive ? " active" : ""}`}
            aria-pressed={parameterEntryActive}
            title={
              parameterEntryActive
                ? "Switch back to picking a literal value"
                : "Supply this value at run time via a $param reference"
            }
            onClick={toggleParameterEntry}
          >
            $param
          </button>
        </div>
      ) : (
        control
      )}
    </div>
  );
}
