import { useEffect, useMemo, useState } from "react";
import { Picker } from "./Picker";
import { AddParameterModal } from "./modals/AddParameterModal";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  bindingDisplayLabels,
  bindingForVariable,
  collectReadMatchPathBindings,
  formatParameterInput,
  isReturnFieldParameter,
  resolvedReadReturnFields,
  unwindItemPatch
} from "@pona-flow/authoring";
import { removeUnwindItem, updateUnwindItem } from "../../state/builder/queryHelpers";
import { fetchWherePropertyKeysForEntity } from "./where/wherePropertyOptions";
import type { UnwindItem } from "../../state/builder/types";

interface UnwindProjectionRowProps {
  index: number;
  item: UnwindItem;
}

const ADD_PARAMETER_ACTION_LABEL = "+ ADD A PARAMETER";

export function UnwindProjectionRow({ index, item }: UnwindProjectionRowProps) {
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

  const displayLabels = bindingDisplayLabels(bindings);
  const schemaOptions = bindings
    .filter((b) => !b.variableLength)
    .map((b) => ({
      value: b.variable,
      label: displayLabels.get(b.variable) ?? b.attributive_label
    }));

  const binding =
    resolved.path_variable ? bindingForVariable(bindings, resolved.path_variable) : undefined;
  const schemaIsParameter =
    isReturnFieldParameter(resolved.path_variable) ||
    isReturnFieldParameter(binding?.attributive_label ?? "");
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

  function patch(pathVariable: string, propertyKey: string) {
    patchQuery(updateUnwindItem(index, unwindItemPatch(bindings, pathVariable, propertyKey)));
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
            createActions={[
              { label: ADD_PARAMETER_ACTION_LABEL, onClick: () => setShowSchemaParamModal(true) }
            ]}
            onSelect={(variable) => patch(variable, "")}
            emptyHint={
              bindings.length
                ? undefined
                : "Set attributive_label on MATCH nodes and relationships first."
            }
          />
        </div>
        <div className="builderField">
          <label>property</label>
          {schemaIsParameter || propertyIsParameter ? (
            <input
              className="builderMono"
              placeholder="$param"
              value={resolved.property_key}
              disabled={!resolved.path_variable}
              onChange={(e) => {
                if (!resolved.path_variable) return;
                patch(resolved.path_variable, formatParameterInput(e.target.value));
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
                patch(resolved.path_variable, key);
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
        <button
          type="button"
          className="builderTinyBtn builderDanger"
          onClick={() => patchQuery(removeUnwindItem(index))}
        >
          Remove
        </button>
      </div>
      {showSchemaParamModal ? (
        <AddParameterModal
          onCancel={() => setShowSchemaParamModal(false)}
          onSave={(param) => {
            setShowSchemaParamModal(false);
            patch(param, "");
          }}
        />
      ) : null}
      {showPropertyParamModal ? (
        <AddParameterModal
          onCancel={() => setShowPropertyParamModal(false)}
          onSave={(param) => {
            setShowPropertyParamModal(false);
            if (!resolved.path_variable) return;
            patch(resolved.path_variable, param);
          }}
        />
      ) : null}
    </div>
  );
}
