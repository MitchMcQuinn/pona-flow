import { useEffect, useId, useMemo, useState } from "react";
import { Picker } from "./Picker";
import connector from "../../services/connector";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  bindingDisplayLabels,
  bindingForVariable,
  collectReadMatchPathBindings
} from "@pona-flow/authoring";
import {
  isSetValueParameter,
  resolvedSetFields,
  setItemPatch,
  type SetExpressionInputs
} from "../../state/builder/setProjections";
import { updateSetItem } from "../../state/builder/queryHelpers";
import { formatParameterInput, isAttributiveLabelParameter } from "@pona-flow/authoring";
import { validateInstanceValue } from "@pona-flow/authoring";
import { schemaConstraintMap } from "../../state/builder/updateInstanceGuard";
import { fetchWherePropertyKeysForEntity, fetchWherePropertyValuesForEntity } from "./where/wherePropertyOptions";
import type { SchematicProperties, SetItem, SetValueMode } from "../../state/builder/types";

interface SetProjectionRowProps {
  index: number;
  item: SetItem;
  onRemove: () => void;
}

const MODE_LABELS: Record<SetValueMode, string> = {
  literal: "value",
  now: "now (timestamp)",
  not_property: "negate property (NOT)",
  expression: "expression"
};

export function SetProjectionRow({ index, item, onRemove }: SetProjectionRowProps) {
  const { state, patchQuery } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const valueListId = useId();
  const bindings = useMemo(() => collectReadMatchPathBindings(state.query), [state.query]);
  const resolved = resolvedSetFields(item, bindings);
  const mode = resolved.value_mode;
  const [propertyKeys, setPropertyKeys] = useState<string[]>([]);
  const [valueOptions, setValueOptions] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<Map<string, SchematicProperties>>(new Map());
  const [sourceConstraints, setSourceConstraints] = useState<Map<string, SchematicProperties>>(
    new Map()
  );

  // Variable-length aliases bind relationship *lists* — alias.prop assignment
  // targets would be invalid Cypher, so they are never offered.
  const displayLabels = bindingDisplayLabels(bindings);
  const schemaOptions = bindings
    .filter((b) => !b.variableLength)
    .map((b) => ({
      value: b.variable,
      label: displayLabels.get(b.variable) ?? b.attributive_label
    }));

  const binding = resolved.path_variable
    ? bindingForVariable(bindings, resolved.path_variable)
    : undefined;
  const valueIsParameter = isSetValueParameter(resolved.value);
  // A parameterized schema (attributive_label is a $param) has no concrete graph
  // schema to read property keys/values from, so the property must be entered as a
  // parameter too (mirrors the parameterized WHERE filter cards).
  const schemaIsParameter = isAttributiveLabelParameter(binding?.attributive_label ?? "");

  useEffect(() => {
    if (!spaceId || !binding || schemaIsParameter) {
      setPropertyKeys([]);
      return;
    }
    let cancelled = false;
    // The engine-minted instance id is filterable in WHERE but never assignable in SET.
    fetchWherePropertyKeysForEntity({
      spaceId,
      matchClauseLabel: "INSTANCE",
      entityRole: binding.entityRole,
      attributiveLabel: binding.attributive_label,
      omitInstanceAutoId: true
    }).then((keys) => {
      if (!cancelled) setPropertyKeys(keys);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, binding?.attributive_label, binding?.entityRole, binding?.variable, schemaIsParameter]);

  useEffect(() => {
    if (!spaceId || !binding || schemaIsParameter || !resolved.property_key || mode !== "literal") {
      setValueOptions([]);
      return;
    }
    let cancelled = false;
    fetchWherePropertyValuesForEntity({
      spaceId,
      matchClauseLabel: "INSTANCE",
      entityRole: binding.entityRole,
      attributiveLabel: binding.attributive_label,
      propertyKey: resolved.property_key
    }).then((values) => {
      if (!cancelled) setValueOptions(values);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, binding?.attributive_label, binding?.entityRole, binding?.variable, schemaIsParameter, resolved.property_key, mode]);

  // Schema constraints for inline value validation (parity with create's InstancePropertyField).
  useEffect(() => {
    if (!spaceId || !binding || schemaIsParameter) {
      setConstraints(new Map());
      return;
    }
    let cancelled = false;
    connector
      .fetchSchemaDefinition({ spaceId, attributiveLabel: binding.attributive_label })
      .then((def) => {
        if (!cancelled) setConstraints(schemaConstraintMap(def));
      })
      .catch(() => {
        if (!cancelled) setConstraints(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, binding?.attributive_label, schemaIsParameter]);

  // not_property mode: constraints of the picked source alias's schema, used to
  // limit the source-property picker to boolean properties.
  const sourceBinding = resolved.source_variable
    ? bindingForVariable(bindings, resolved.source_variable)
    : undefined;
  useEffect(() => {
    if (!spaceId || mode !== "not_property" || !sourceBinding) {
      setSourceConstraints(new Map());
      return;
    }
    let cancelled = false;
    connector
      .fetchSchemaDefinition({ spaceId, attributiveLabel: sourceBinding.attributive_label })
      .then((def) => {
        if (!cancelled) setSourceConstraints(schemaConstraintMap(def));
      })
      .catch(() => {
        if (!cancelled) setSourceConstraints(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, mode, sourceBinding?.attributive_label]);

  const valueConstraint = resolved.property_key ? constraints.get(resolved.property_key) : undefined;
  const valueCheck =
    mode === "literal" && valueConstraint && resolved.value && !valueIsParameter
      ? validateInstanceValue(valueConstraint, String(resolved.value))
      : null;

  // Mode availability tracks the target property's declared type: "now" writes an
  // ISO timestamp string, "not_property" a boolean. An unknown constraint (schema
  // still loading / parameterized) offers everything; the update guard re-checks.
  const targetType = valueConstraint?.value_type;
  const availableModes: SetValueMode[] = ["literal"];
  if (!targetType || targetType === "string") availableModes.push("now");
  if (!targetType || targetType === "boolean") availableModes.push("not_property");
  availableModes.push("expression");
  if (!availableModes.includes(mode)) availableModes.push(mode);

  const booleanSourceKeys = Array.from(sourceConstraints.entries())
    .filter(([, sp]) => sp.value_type === "boolean")
    .map(([key]) => key);

  function patch(
    pathVariable: string,
    propertyKey: string,
    value: string,
    inputs: Partial<SetExpressionInputs> = {}
  ) {
    patchQuery(updateSetItem(index, setItemPatch(bindings, pathVariable, propertyKey, value, inputs)));
  }

  function patchMode(nextMode: SetValueMode) {
    // Switching modes resets the right-hand side; the target schema/property stay.
    patch(resolved.path_variable, resolved.property_key, "", { mode: nextMode });
  }

  return (
    <div className="builderItemRow">
      <div className="builderRow">
        <div className="builderField">
          <label>schema</label>
          <Picker
            value={resolved.path_variable}
            placeholder="(select path)"
            options={schemaOptions}
            onSelect={(variable) => patch(variable, "", "")}
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
              onChange={(e) =>
                patch(resolved.path_variable, formatParameterInput(e.target.value), resolved.value, {
                  mode
                })
              }
            />
          ) : (
            <Picker
              value={resolved.property_key}
              placeholder={resolved.path_variable ? "(select property)" : "(select schema first)"}
              options={propertyKeys.map((k) => ({ value: k, label: k }))}
              disabled={!resolved.path_variable}
              onSelect={(key) => patch(resolved.path_variable, key, resolved.value, { mode })}
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
          <label>mode</label>
          <select
            value={mode}
            disabled={!resolved.property_key}
            onChange={(e) => patchMode(e.target.value as SetValueMode)}
            title={
              "value: literal or $parameter. now: toString(datetime()) at run time (string properties). " +
              "negate property: NOT coalesce(source.prop, false) (boolean properties). " +
              "expression: raw Cypher right-hand side, validated only at run time."
            }
          >
            {availableModes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
        {mode === "literal" ? (
          <div className="builderField">
            <label>
              value
              {valueCheck && !valueCheck.valid ? (
                <span className="builderCheckMsg duplicate"> {valueCheck.message}</span>
              ) : null}
            </label>
            <input
              className="builderMono"
              list={valueOptions.length ? valueListId : undefined}
              placeholder="value or $param"
              value={resolved.value}
              disabled={!resolved.property_key}
              onChange={(e) => patch(resolved.path_variable, resolved.property_key, e.target.value)}
            />
            {valueOptions.length ? (
              <datalist id={valueListId}>
                {valueOptions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            ) : null}
          </div>
        ) : null}
        {mode === "now" ? (
          <div className="builderField">
            <label>value</label>
            <input className="builderMono" readOnly value="toString(datetime())" />
          </div>
        ) : null}
        {mode === "not_property" ? (
          <>
            <div className="builderField">
              <label>source</label>
              <Picker
                value={resolved.source_variable}
                placeholder="(select path)"
                options={schemaOptions}
                disabled={!resolved.property_key}
                onSelect={(variable) =>
                  patch(resolved.path_variable, resolved.property_key, "", {
                    mode,
                    sourceVariable: variable
                  })
                }
              />
            </div>
            <div className="builderField">
              <label>source property (boolean)</label>
              <Picker
                value={resolved.source_property}
                placeholder={resolved.source_variable ? "(select property)" : "(select source first)"}
                options={booleanSourceKeys.map((k) => ({ value: k, label: k }))}
                disabled={!resolved.source_variable}
                onSelect={(key) =>
                  patch(resolved.path_variable, resolved.property_key, "", {
                    mode,
                    sourceVariable: resolved.source_variable,
                    sourceProperty: key
                  })
                }
                emptyHint={
                  sourceBinding
                    ? booleanSourceKeys.length
                      ? undefined
                      : "No boolean properties on this schema."
                    : undefined
                }
              />
            </div>
          </>
        ) : null}
        {mode === "expression" ? (
          <div className="builderField">
            <label>expression (right-hand side)</label>
            <input
              className="builderMono"
              placeholder="e.g. coalesce(n.count, 0) + 1"
              value={resolved.value}
              disabled={!resolved.property_key}
              onChange={(e) =>
                patch(resolved.path_variable, resolved.property_key, e.target.value, { mode })
              }
            />
            <span className="builderCheckMsg muted" style={{ fontSize: 11 }}>
              Raw Cypher — validated only when the operation runs.
            </span>
          </div>
        ) : null}
      </div>
      <div className="builderRowActions">
        <button type="button" className="builderTinyBtn builderDanger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}
