import { useEffect, useMemo, useState } from "react";
import { Picker } from "./Picker";
import { AddParameterModal } from "./modals/AddParameterModal";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  bindingDisplayLabels,
  bindingForVariable,
  collectReadMatchPathBindings,
  isReturnFieldParameter
} from "../../state/builder/returnProjections";
import {
  orderByItemPatch,
  resolvedOrderByFields
} from "../../state/builder/orderByProjections";
import { removeOrderBy, updateOrderBy } from "../../state/builder/queryHelpers";
import { fetchWherePropertyKeysForEntity } from "./where/wherePropertyOptions";
import type { OrderByItem } from "../../state/builder/types";

interface OrderByProjectionRowProps {
  index: number;
  item: OrderByItem;
}

const ADD_PARAMETER_ACTION_LABEL = "+ ADD A PARAMETER";

export function OrderByProjectionRow({ index, item }: OrderByProjectionRowProps) {
  const { state, patchQuery } = useBuilder();
  const spaceId = state.spaceId ?? "";
  const bindings = useMemo(
    () => collectReadMatchPathBindings(state.query),
    [state.query]
  );
  const resolved = resolvedOrderByFields(item, bindings);
  const [propertyKeys, setPropertyKeys] = useState<string[]>([]);
  const [showSchemaParamModal, setShowSchemaParamModal] = useState(false);
  const [showPropertyParamModal, setShowPropertyParamModal] = useState(false);

  // Variable-length aliases bind relationship *lists* — alias.prop sort keys
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
  const schemaIsParameter = isReturnFieldParameter(resolved.path_variable);

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

  function patch(partial: Partial<OrderByItem>) {
    patchQuery(updateOrderBy(index, partial));
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
            onSelect={(variable) => {
              patch(orderByItemPatch(bindings, variable, ""));
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
          <Picker
            value={resolved.property_key}
            placeholder={resolved.path_variable ? "(select property)" : "(select schema first)"}
            options={schemaIsParameter ? [] : propertyKeys.map((k) => ({ value: k, label: k }))}
            disabled={!resolved.path_variable}
            createActions={[
              { label: ADD_PARAMETER_ACTION_LABEL, onClick: () => setShowPropertyParamModal(true) }
            ]}
            onSelect={(key) => {
              if (!resolved.path_variable) return;
              patch(orderByItemPatch(bindings, resolved.path_variable, key));
            }}
            emptyHint={
              schemaIsParameter
                ? "Schema is a parameter — add a parameter for the property too."
                : binding
                  ? propertyKeys.length
                    ? undefined
                    : "No properties found on graph for this schema."
                  : undefined
            }
          />
        </div>
        <div className="builderField">
          <label>direction</label>
          <select
            value={item.direction}
            onChange={(e) => patch({ direction: e.target.value as "ASC" | "DESC" })}
          >
            <option value="ASC">ASC</option>
            <option value="DESC">DESC</option>
          </select>
        </div>
        <button
          type="button"
          className="builderTinyBtn builderDanger"
          onClick={() => patchQuery(removeOrderBy(index))}
        >
          Remove
        </button>
      </div>
      {showSchemaParamModal ? (
        <AddParameterModal
          onCancel={() => setShowSchemaParamModal(false)}
          onSave={(param) => {
            setShowSchemaParamModal(false);
            patch(orderByItemPatch(bindings, param, ""));
          }}
        />
      ) : null}
      {showPropertyParamModal ? (
        <AddParameterModal
          onCancel={() => setShowPropertyParamModal(false)}
          onSave={(param) => {
            setShowPropertyParamModal(false);
            if (!resolved.path_variable) return;
            patch(orderByItemPatch(bindings, resolved.path_variable, param));
          }}
        />
      ) : null}
    </div>
  );
}
