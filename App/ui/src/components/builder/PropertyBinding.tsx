import { useState } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  removeProperty,
  updateProperty,
  updateSchematic
} from "../../state/builder/queryHelpers";
import { newSchematicProperties } from "../../state/builder/defaults";
import {
  choiceConfigOf,
  isImplicitSchemaKeyName,
  validateSchemaDefaultValue,
  validateSchemaPropertyKey
} from "@pona-flow/authoring";
import { extractExactParameterRef } from "@pona-flow/authoring";
import { sanitizeSchemaPropertyKeyInput } from "@pona-flow/authoring";
import type {
  PropertyBinding as PropertyBindingType,
  SchematicProperties,
  ValueType
} from "../../state/builder/types";
import { Toggle } from "./Toggle";
import { RegexPatternModal } from "./modals/RegexPatternModal";
import { TypedValueInput } from "./fields/TypedValueInput";
import { ChoiceOptionsEditor } from "./fields/ChoiceOptionsEditor";
import { useSpaceEmbeddingsEnabled } from "./fields/useSpaceEmbeddingsEnabled";

const VALUE_TYPES: ValueType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "UID",
  "radio",
  "checkbox"
];
const ADD_REGEX_VALUE = "__add_regex_pattern__";

interface PropertyBindingProps {
  clauseIndex: number;
  patternIndex: number;
  pathIndex: number;
  propIndex: number;
  prop: PropertyBindingType;
  schemaMode?: boolean;
  canDelete?: boolean;
  /**
   * Existing SCHEMA property loaded for an update: its *structural* identity is immutable
   * (name, value_type, format, choice options), so those fields render read-only. Its label,
   * required, indexed flags and default_value remain editable.
   */
  locked?: boolean;
  /**
   * Property of a shared relationship type being reused: fully read-only (flags and
   * default included), since edits belong to the type and go through the schema-update flow.
   */
  readOnly?: boolean;
  /**
   * The owning SCHEMA takes part in vector search, so the `is_embedded` flag is meaningful and
   * gets a toggle. Hidden otherwise — an embed flag on a type nothing indexes is just noise.
   */
  vectorized?: boolean;
}

export function PropertyBinding({
  clauseIndex,
  patternIndex,
  pathIndex,
  propIndex,
  prop,
  schemaMode = false,
  canDelete = true,
  locked = false,
  readOnly = false,
  vectorized = false
}: PropertyBindingProps) {
  const { state, patchQuery } = useBuilder();
  const embeddingsEnabled = useSpaceEmbeddingsEnabled();
  const usingParameter = prop.parameter !== undefined;
  const [showRegexModal, setShowRegexModal] = useState(false);

  const patch = (p: Partial<PropertyBindingType>) =>
    patchQuery(updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, p));

  if (schemaMode) {
    const schema = prop.schematic_properties ?? newSchematicProperties();
    const patchSchema = (p: Partial<SchematicProperties>) =>
      patchQuery(updateSchematic(clauseIndex, patternIndex, pathIndex, propIndex, p));

    const structuralLock = locked || readOnly;
    const requiredLocked = schema.is_label || readOnly;
    const isUid = schema.value_type === "UID";
    const formatOptions = state.regexPatterns.length
      ? state.regexPatterns.map((r) => r.name)
      : ["any"];
    const defaultRaw = String(prop.value ?? "");
    const defaultParamRef = extractExactParameterRef(defaultRaw);
    const refParam = defaultParamRef
      ? state.query.parameters.find((p) => String(p.name ?? "").trim() === defaultParamRef)
      : undefined;
    const defaultCheck =
      refParam && refParam.schematic_properties
        ? validateSchemaDefaultValue(
            refParam.schematic_properties.value_type,
            refParam.schematic_properties.format,
            String(refParam.value ?? ""),
            choiceConfigOf(refParam.schematic_properties)
          )
        : validateSchemaDefaultValue(schema.value_type, schema.format, defaultRaw, choiceConfigOf(schema));
    const keyCheck = validateSchemaPropertyKey(prop.key);
    const isChoiceType = schema.value_type === "radio" || schema.value_type === "checkbox";

    return (
      <div
        className={`builderCard nested builderItemRow builderPropertyCard${
          canDelete ? " builderPropertyCardRemovable" : ""
        }`}
      >
        {canDelete ? (
          <button
            type="button"
            className="builderPropertyRemove"
            aria-label="Remove property"
            title="Remove property"
            onClick={() =>
              patchQuery(removeProperty(clauseIndex, patternIndex, pathIndex, propIndex))
            }
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
        ) : null}
        {locked && !readOnly ? (
          <p className="builderCheckMsg builderPropertyLockNote">
            Existing property — its value type and format are locked. You can still change its
            label, required, and indexed flags, edit its default, or delete it.
          </p>
        ) : null}
        <div
          className={
            keyCheck.valid
              ? "builderField builderPropertyName"
              : "builderField builderFieldMissing builderPropertyName"
          }
        >
          <input
            className="builderPropertyNameInput"
            aria-label="property name"
            value={prop.key}
            placeholder="name or $parameter"
            disabled={structuralLock}
            onChange={(e) => {
              const next = sanitizeSchemaPropertyKeyInput(e.target.value);
              // Only the implicit key is blocked mid-typing; the other reserved names are
              // prefixes of plausible ones (EMBEDDING_DATE), so those fail validation instead.
              if (isImplicitSchemaKeyName(next)) return;
              patch({ key: next });
            }}
          />
          {!keyCheck.valid && prop.key.trim() ? (
            <span className="builderCheckMsg duplicate">{keyCheck.message}</span>
          ) : null}
        </div>
        <div className="builderRowFlags">
          <Toggle
            checked={schema.is_required}
            onChange={(value) => patchSchema({ is_required: value })}
            label="required"
            disabled={requiredLocked}
          />
          <Toggle
            checked={schema.is_label}
            onChange={(value) => patchSchema({ is_label: value })}
            label="label"
            disabled={readOnly}
          />
          <Toggle
            checked={schema.is_indexed}
            onChange={(value) => patchSchema({ is_indexed: value })}
            label="indexed"
            disabled={readOnly}
          />
          {vectorized && embeddingsEnabled ? (
            <Toggle
              checked={schema.is_embedded === true}
              onChange={(value) => patchSchema({ is_embedded: value })}
              label="is_embedded"
              disabled={readOnly}
            />
          ) : null}
        </div>
        <div className="builderPropertyTypeRow">
          <div className="builderField">
            <label>type</label>
            <select
              value={schema.value_type}
              disabled={structuralLock}
              onChange={(e) => patchSchema({ value_type: e.target.value as ValueType })}
            >
              {VALUE_TYPES.map((vt) => (
                <option key={vt} value={vt}>
                  {vt}
                </option>
              ))}
            </select>
          </div>
          {schema.value_type === "string" ? (
            <div className="builderField">
              <label>format</label>
              <select
                value={schema.format ?? "any"}
                disabled={structuralLock}
                onChange={(e) => {
                  if (e.target.value === ADD_REGEX_VALUE) {
                    setShowRegexModal(true);
                    return;
                  }
                  patchSchema({ format: e.target.value });
                }}
              >
                <option value={ADD_REGEX_VALUE}>+ REGEX PATTERN</option>
                {formatOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        {isChoiceType ? (
          <ChoiceOptionsEditor
            valueType={schema.value_type as "radio" | "checkbox"}
            options={schema.options ?? []}
            minChoices={schema.min_choices}
            maxChoices={schema.max_choices}
            disabled={structuralLock}
            onChange={patchSchema}
          />
        ) : null}

        {!isUid ? (
          <div className="builderField">
            <label>
              default_value
              {!defaultCheck.valid ? (
                <span className="builderCheckMsg duplicate">{defaultCheck.message}</span>
              ) : defaultRaw.trim() && defaultCheck.message ? (
                <span className="builderCheckMsg ok">{defaultCheck.message}</span>
              ) : null}
            </label>
            <TypedValueInput
              valueType={schema.value_type}
              options={schema.options}
              minChoices={schema.min_choices}
              maxChoices={schema.max_choices}
              value={defaultRaw}
              placeholder="(no default)"
              readOnly={readOnly}
              onChange={(next) => patch({ value: next })}
            />
          </div>
        ) : null}
        {showRegexModal ? <RegexPatternModal onClose={() => setShowRegexModal(false)} /> : null}
      </div>
    );
  }

  return (
    <div className="builderCard nested builderItemRow builderPropertyCard">
      <div className="builderRow">
        <div className="builderField">
          <label>key</label>
          <input
            value={prop.key}
            placeholder="property"
            onChange={(e) =>
              patchQuery(updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, { key: e.target.value }))
            }
          />
        </div>

        <div className="builderField">
          <label>source</label>
          <select
            value={usingParameter ? "parameter" : "literal"}
            onChange={(e) => {
              if (e.target.value === "parameter") {
                patchQuery(
                  updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, {
                    value: undefined,
                    parameter: state.query.parameters[0]?.name ?? ""
                  })
                );
              } else {
                patchQuery(
                  updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, {
                    parameter: undefined,
                    value: ""
                  })
                );
              }
            }}
          >
            <option value="literal">literal</option>
            <option value="parameter">parameter</option>
          </select>
        </div>

        {usingParameter ? (
          <div className="builderField">
            <label>parameter</label>
            <select
              value={prop.parameter ?? ""}
              onChange={(e) =>
                patchQuery(
                  updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, {
                    parameter: e.target.value
                  })
                )
              }
            >
              <option value="">(select)</option>
              {state.query.parameters.map((p) => (
                <option key={p.name} value={p.name}>
                  ${p.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="builderField">
            <label>value</label>
            <input
              value={String(prop.value ?? "")}
              onChange={(e) =>
                patchQuery(
                  updateProperty(clauseIndex, patternIndex, pathIndex, propIndex, { value: e.target.value })
                )
              }
            />
          </div>
        )}
      </div>

      <div className="builderRowActions">
        <button
          type="button"
          className="builderTinyBtn builderDanger"
          title="Remove property"
          onClick={() => patchQuery(removeProperty(clauseIndex, patternIndex, pathIndex, propIndex))}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
