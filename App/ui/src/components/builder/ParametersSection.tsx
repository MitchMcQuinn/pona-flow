import { useState } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import connector from "../../services/connector";
import { updateParameterAt } from "../../state/builder/queryHelpers";
import { newSchematicProperties } from "../../state/builder/defaults";
import {
  ATTRIBUTIVE_LABEL_VALUE_TYPE,
  collectLockedParameterNames,
  collectValueTypeLockedParameterNames
} from "@pona-flow/authoring";
import { isValidParameterName } from "@pona-flow/authoring";
import {
  choiceConfigOf,
  validateAttributiveLabelValue,
  validateSchemaDefaultValue
} from "@pona-flow/authoring";
import type { Parameter, SchematicProperties, ValueType } from "../../state/builder/types";
import { Toggle } from "./Toggle";
import { RegexPatternModal } from "./modals/RegexPatternModal";
import { TypedValueInput } from "./fields/TypedValueInput";
import { ChoiceOptionsEditor } from "./fields/ChoiceOptionsEditor";
import { useDebouncedCheck } from "./hooks/useDebouncedCheck";

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

function parameterDataType(valueType: ValueType): "string" | "number" | "integer" | "boolean" | "array" {
  if (valueType === "UID" || valueType === ATTRIBUTIVE_LABEL_VALUE_TYPE) return "string";
  if (valueType === "radio") return "string";
  if (valueType === "checkbox") return "array";
  return valueType;
}

interface ParameterRowProps {
  index: number;
  param: Parameter;
  /** Locks name + required (origin-driven, e.g. attributive_label / RETURN field / SKIP / LIMIT). */
  locked: boolean;
  /** Additionally locks value_type + format (origin forces a fixed type). */
  typeLocked: boolean;
  formatOptions: string[];
  /** create SCHEMA/STEP: attributive_label parameter defaults must be globally unique. */
  enforceAttributiveUniqueness: boolean;
  onOpenRegexModal: () => void;
}

function ParameterRow({
  index,
  param,
  locked,
  typeLocked,
  formatOptions,
  enforceAttributiveUniqueness,
  onOpenRegexModal
}: ParameterRowProps) {
  const { state, patchQuery } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const nameInvalid = param.name !== "" && !isValidParameterName(param.name);
  const schema = param.schematic_properties;
  const valueType = (schema?.value_type ?? "string") as ValueType;
  const isAttributiveLabel = valueType === ATTRIBUTIVE_LABEL_VALUE_TYPE;
  const valueTypeOptions: ValueType[] = isAttributiveLabel
    ? [ATTRIBUTIVE_LABEL_VALUE_TYPE, ...VALUE_TYPES]
    : VALUE_TYPES;
  const rawValue = String(param.value ?? "");
  const isChoiceType = valueType === "radio" || valueType === "checkbox";
  const formatCheck = isAttributiveLabel
    ? validateAttributiveLabelValue(rawValue)
    : validateSchemaDefaultValue(
        valueType,
        schema?.format,
        rawValue,
        schema ? choiceConfigOf(schema) : undefined
      );
  const patchSchema = (changes: Partial<SchematicProperties>) =>
    patchQuery(
      updateParameterAt(index, {
        schematic_properties: {
          ...newSchematicProperties(),
          ...(schema ?? {}),
          ...changes
        }
      })
    );

  // Uniqueness of an attributive_label parameter's default value (create SCHEMA/STEP),
  // mirroring the literal attributive_label check. Globally unique across STEP/SCHEMA/POINTS_TO.
  const uniquenessKey = `alparam:${param.name}`;
  const uniquenessEnabled = Boolean(
    isAttributiveLabel &&
      enforceAttributiveUniqueness &&
      spaceId &&
      rawValue.trim() &&
      formatCheck.valid
  );
  useDebouncedCheck(
    uniquenessKey,
    uniquenessEnabled,
    `${spaceId}|${rawValue.trim()}`,
    async () => {
      const taken = await connector.checkAttributiveLabelExists({
        spaceId,
        attributiveLabel: rawValue.trim()
      });
      return taken
        ? { status: "duplicate", message: "already taken" }
        : { status: "ok", message: "valid" };
    }
  );
  const uniquenessCheck = state.checks[uniquenessKey];

  return (
    <div className="builderItemRow">
      <div className="builderRow">
        <div className="builderField">
          <label>name</label>
          <input
            className="builderMono"
            value={param.name}
            readOnly={locked}
            onChange={(e) => patchQuery(updateParameterAt(index, { name: e.target.value }))}
          />
          {nameInvalid ? (
            <span className="builderCheckMsg duplicate">
              start with a letter or underscore; no leading digit
            </span>
          ) : null}
        </div>
        <div className="builderField">
          <label>value_type</label>
          <select
            value={(schema?.value_type ?? "string") as ValueType}
            disabled={typeLocked}
            onChange={(e) => {
              const value_type = e.target.value as ValueType;
              patchQuery(
                updateParameterAt(index, {
                  data_type: parameterDataType(value_type),
                  schematic_properties: {
                    ...newSchematicProperties(),
                    ...(schema ?? {}),
                    value_type
                  }
                })
              );
            }}
          >
            {valueTypeOptions.map((vt) => (
              <option key={vt} value={vt}>
                {vt}
              </option>
            ))}
          </select>
        </div>
        {valueType === "string" ? (
          <div className="builderField">
            <label>format</label>
            <select
              value={schema?.format ?? "any"}
              disabled={typeLocked}
              onChange={(e) => {
                if (e.target.value === ADD_REGEX_VALUE) {
                  onOpenRegexModal();
                  return;
                }
                patchQuery(
                  updateParameterAt(index, {
                    schematic_properties: {
                      ...newSchematicProperties(),
                      ...(schema ?? {}),
                      format: e.target.value || undefined
                    }
                  })
                );
              }}
            >
              {!typeLocked ? <option value={ADD_REGEX_VALUE}>+ REGEX PATTERN</option> : null}
              {formatOptions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="builderField">
          <label>
            default_value
            {!formatCheck.valid ? (
              <span className="builderCheckMsg duplicate">{formatCheck.message}</span>
            ) : isAttributiveLabel && uniquenessCheck && uniquenessCheck.status !== "idle" ? (
              <span className={`builderCheckMsg ${uniquenessCheck.status}`}>
                {uniquenessCheck.status === "checking" ? "checking…" : uniquenessCheck.message}
              </span>
            ) : rawValue.trim() && formatCheck.message ? (
              <span className="builderCheckMsg ok">{formatCheck.message}</span>
            ) : null}
          </label>
          {isChoiceType ? (
            <TypedValueInput
              valueType={valueType}
              options={schema?.options}
              minChoices={schema?.min_choices}
              maxChoices={schema?.max_choices}
              value={rawValue}
              placeholder="(no default)"
              onChange={(next) => patchQuery(updateParameterAt(index, { value: next }))}
            />
          ) : (
            <input
              value={rawValue}
              onChange={(e) =>
                patchQuery(
                  updateParameterAt(index, {
                    value: isAttributiveLabel
                      ? e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")
                      : e.target.value
                  })
                )
              }
            />
          )}
        </div>
      </div>
      {isChoiceType ? (
        <div className="builderRow">
          <ChoiceOptionsEditor
            valueType={valueType as "radio" | "checkbox"}
            options={schema?.options ?? []}
            minChoices={schema?.min_choices}
            maxChoices={schema?.max_choices}
            disabled={typeLocked}
            onChange={patchSchema}
          />
        </div>
      ) : null}
      <div className="builderRow">
        <div className="builderField">
          <label>description (optional)</label>
          <input
            value={String(param.description ?? "")}
            placeholder="What this parameter is. Shown to MCP agents in the tool's input schema."
            onChange={(e) => patchQuery(updateParameterAt(index, { description: e.target.value }))}
          />
        </div>
      </div>
      <div className="builderRowActions">
        <Toggle
          checked={Boolean(param.is_required)}
          onChange={(checked) => patchQuery(updateParameterAt(index, { is_required: checked }))}
          label="required"
          labelFirst
          disabled={locked}
        />
      </div>
    </div>
  );
}

export function ParametersSection() {
  const { state } = useBuilder();
  const params = state.query.parameters;
  const op = state.query.operation;
  const clauseLabel = state.query.match[0]?.label;
  const schemaCreate = op === "create" && clauseLabel === "SCHEMA";
  const enforceAttributiveUniqueness =
    op === "create" && (clauseLabel === "SCHEMA" || clauseLabel === "STEP");
  const lockedNames = collectLockedParameterNames(state.query);
  const typeLockedNames = collectValueTypeLockedParameterNames(state.query);
  const formatOptions = state.regexPatterns.length ? state.regexPatterns.map((r) => r.name) : ["any"];
  const [showRegexModal, setShowRegexModal] = useState(false);

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Parameters</h3>
      </div>

      {params.length === 0 ? (
        <p className="builderCheckMsg">
          {schemaCreate
            ? "No parameters yet. Reference parameters with $name in property name or default value fields."
            : "No parameters found in value fields. Reference parameters with $name."}
        </p>
      ) : null}

      {params.map((param, index) => (
        <ParameterRow
          key={index}
          index={index}
          param={param}
          locked={lockedNames.has(String(param.name ?? "").trim())}
          typeLocked={typeLockedNames.has(String(param.name ?? "").trim())}
          formatOptions={formatOptions}
          enforceAttributiveUniqueness={enforceAttributiveUniqueness}
          onOpenRegexModal={() => setShowRegexModal(true)}
        />
      ))}
      {showRegexModal ? <RegexPatternModal onClose={() => setShowRegexModal(false)} /> : null}
    </section>
  );
}
