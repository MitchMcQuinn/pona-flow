import { useEffect, useMemo, useState } from "react";
import { Picker } from "./Picker";
import { Toggle } from "./Toggle";
import { AddParameterModal } from "./modals/AddParameterModal";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  bindingDisplayLabels,
  bindingForVariable,
  collectReadMatchPathBindings,
  isReturnFieldParameter,
  readReturnItemPatch,
  resolvedReadReturnFields,
  type ReturnBooleanInputs
} from "@pona-flow/authoring";
import { updateReturnItem } from "../../state/builder/queryHelpers";
import {
  ALIAS_NAME_ERROR_MSG,
  formatParameterInput,
  isAttributiveLabelParameter,
  normalizeAlias,
  validateOptionalAlias
} from "@pona-flow/authoring";
import { fetchWherePropertyKeysForEntity } from "./where/wherePropertyOptions";
import {
  comparisonOperatorNeedsValue,
  WHERE_COMPARISON_OPERATORS
} from "../../state/builder/types";
import type { ReturnItem, WhereComparisonOperator } from "../../state/builder/types";

interface ReadReturnProjectionRowProps {
  index: number;
  item: ReturnItem;
  onRemove: () => void;
}

const ADD_PARAMETER_ACTION_LABEL = "+ ADD A PARAMETER";
const DEFAULT_COMPARISON_OPERATOR: WhereComparisonOperator = "=";

export function ReadReturnProjectionRow({
  index,
  item,
  onRemove
}: ReadReturnProjectionRowProps) {
  const { state, patchQuery } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const bindings = useMemo(
    () => collectReadMatchPathBindings(state.query),
    [state.query]
  );
  const resolved = resolvedReadReturnFields(item, bindings);
  const [propertyKeys, setPropertyKeys] = useState<string[]>([]);
  const [showSchemaParamModal, setShowSchemaParamModal] = useState(false);
  const [showPropertyParamModal, setShowPropertyParamModal] = useState(false);

  // Variable-length aliases bind relationship *lists* — alias.prop projections
  // would be invalid Cypher, so they are never offered.
  const displayLabels = bindingDisplayLabels(bindings);
  const schemaOptions = bindings
    .filter((b) => !b.variableLength)
    .map((b) => ({
      value: b.variable,
      label: displayLabels.get(b.variable) ?? b.attributive_label
    }));

  const binding =
    resolved.path_variable ? bindingForVariable(bindings, resolved.path_variable) : undefined;
  // The schema is "a parameter" when the path variable itself is a $param, or when
  // it resolves to a node/relationship whose attributive_label is a $param. Either
  // way there is no concrete schema, so the property must be a parameter too.
  const schemaIsParameter =
    isReturnFieldParameter(resolved.path_variable) ||
    isAttributiveLabelParameter(binding?.attributive_label ?? "");
  const propertyIsParameter = isReturnFieldParameter(resolved.property_key);

  useEffect(() => {
    if (!spaceId || !binding) {
      setPropertyKeys([]);
      return;
    }
    let cancelled = false;
    fetchWherePropertyKeysForEntity({
      spaceId,
      matchClauseLabel: "INSTANCE",
      entityRole: binding.entityRole,
      attributiveLabel: binding.attributive_label
    }).then((keys) => {
      if (!cancelled) setPropertyKeys(keys);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, binding?.attributive_label, binding?.entityRole, binding?.variable]);

  function patch(partial: Partial<ReturnItem>) {
    patchQuery(updateReturnItem(index, partial));
  }

  // The row's current comparison state, carried through every schema/property patch so
  // recompiling the expression never silently drops the boolean configuration.
  const booleanInputs: ReturnBooleanInputs = {
    booleanMode: resolved.boolean_mode,
    operator: resolved.comparison_operator,
    value: resolved.comparison_value
  };

  function patchFields(
    pathVariable: string,
    propertyKey: string,
    inputs: ReturnBooleanInputs = booleanInputs
  ) {
    patch(readReturnItemPatch(bindings, pathVariable, propertyKey, inputs));
  }

  const needsComparisonValue = comparisonOperatorNeedsValue(resolved.comparison_operator);
  const aliasError = validateOptionalAlias(item.alias);
  // A boolean projection's column would otherwise be named after the whole comparison
  // expression, which no downstream response_parameter mapping can address.
  const aliasMissing = resolved.boolean_mode && !(item.alias ?? "").trim();

  return (
    <div className="builderItemRow">
      <div className="builderRow">
        <div className="builderField">
          <label>schema</label>
          <Picker
            value={resolved.path_variable}
            placeholder="(select path)"
            options={schemaOptions}
            createActions={[
              { label: ADD_PARAMETER_ACTION_LABEL, onClick: () => setShowSchemaParamModal(true) }
            ]}
            onSelect={(variable) => {
              // A different schema means a different property, so the value it was
              // compared against no longer applies; the operator choice survives.
              patchFields(variable, "", { ...booleanInputs, value: "" });
            }}
            emptyHint={
              bindings.length
                ? undefined
                : "Set attributive_label on MATCH nodes and relationships first."
            }
          />
        </div>
        <div className="builderField">
          <label>property</label>
          {schemaIsParameter ? (
            <input
              className="builderMono"
              type="text"
              placeholder="$param"
              value={resolved.property_key}
              disabled={!resolved.path_variable}
              onChange={(e) => {
                if (!resolved.path_variable) return;
                patchFields(resolved.path_variable, formatParameterInput(e.target.value));
              }}
            />
          ) : (
            <Picker
              value={resolved.property_key}
              placeholder={resolved.path_variable ? "(select property)" : "(select schema first)"}
              options={propertyKeys.map((k) => ({ value: k, label: k }))}
              disabled={!resolved.path_variable}
              createActions={[
                { label: ADD_PARAMETER_ACTION_LABEL, onClick: () => setShowPropertyParamModal(true) }
              ]}
              onSelect={(key) => {
                if (!resolved.path_variable) return;
                patchFields(resolved.path_variable, key);
              }}
              emptyHint={
                binding
                  ? propertyKeys.length
                    ? undefined
                    : "No properties found on graph for this schema."
                  : undefined
              }
            />
          )}
        </div>
        <div className="builderField">
          <label>return boolean</label>
          <Toggle
            checked={resolved.boolean_mode}
            disabled={!resolved.property_key}
            onChange={(on) =>
              patchFields(resolved.path_variable, resolved.property_key, {
                booleanMode: on,
                operator: on ? DEFAULT_COMPARISON_OPERATOR : undefined,
                value: ""
              })
            }
          />
        </div>
        {resolved.boolean_mode ? (
          <div className="builderField">
            <label>operator</label>
            <select
              value={resolved.comparison_operator ?? DEFAULT_COMPARISON_OPERATOR}
              onChange={(e) => {
                const operator = e.target.value as WhereComparisonOperator;
                patchFields(resolved.path_variable, resolved.property_key, {
                  ...booleanInputs,
                  operator,
                  value: comparisonOperatorNeedsValue(operator) ? resolved.comparison_value : ""
                });
              }}
            >
              {WHERE_COMPARISON_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {resolved.boolean_mode && needsComparisonValue ? (
          <div className="builderField">
            <label>value</label>
            <input
              className="builderMono"
              type="text"
              placeholder="value or $param"
              value={resolved.comparison_value}
              onChange={(e) =>
                patchFields(resolved.path_variable, resolved.property_key, {
                  ...booleanInputs,
                  value: e.target.value
                })
              }
            />
          </div>
        ) : null}
        <div className="builderField">
          <label>{resolved.boolean_mode ? "alias" : "alias (optional)"}</label>
          <input
            className="builderMono"
            placeholder={resolved.boolean_mode ? "e.g. is_active" : "e.g. step1"}
            value={item.alias ?? ""}
            onChange={(e) => {
              const normalized = normalizeAlias(e.target.value);
              patch({ alias: normalized || undefined });
            }}
          />
          {aliasError ? (
            <span className="builderCheckMsg error">{ALIAS_NAME_ERROR_MSG}</span>
          ) : null}
          {!aliasError && aliasMissing ? (
            <span className="builderCheckMsg error">A boolean projection needs an alias.</span>
          ) : null}
        </div>
      </div>
      {resolved.path_variable && resolved.property_key && item.expression ? (
        <p className="builderCheckMsg muted" style={{ marginTop: 4, fontSize: 11 }}>
          Cypher: <span className="builderMono">{item.expression}</span>
          {schemaIsParameter || propertyIsParameter ? " (parameterized — not schema-bound)" : ""}
        </p>
      ) : null}
      <div className="builderRowActions">
        <button type="button" className="builderTinyBtn builderDanger" onClick={onRemove}>
          Remove
        </button>
      </div>
      {showSchemaParamModal ? (
        <AddParameterModal
          onCancel={() => setShowSchemaParamModal(false)}
          onSave={(param) => {
            setShowSchemaParamModal(false);
            patchFields(param, "", { ...booleanInputs, value: "" });
          }}
        />
      ) : null}
      {showPropertyParamModal ? (
        <AddParameterModal
          onCancel={() => setShowPropertyParamModal(false)}
          onSave={(param) => {
            setShowPropertyParamModal(false);
            if (!resolved.path_variable) return;
            patchFields(resolved.path_variable, param);
          }}
        />
      ) : null}
    </div>
  );
}
