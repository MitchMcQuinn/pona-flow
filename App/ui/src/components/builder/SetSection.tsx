import { useEffect } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import { addSetItem, removeSetItem, updateSetItem } from "../../state/builder/queryHelpers";
import {
  bindingForVariable,
  collectReadMatchPathBindings
} from "@pona-flow/authoring";
import { SetProjectionRow } from "./SetProjectionRow";
import { useUpdateInstanceGuard } from "./hooks/useUpdateInstanceGuard";

export function SetSection() {
  const { state, patchQuery } = useBuilder();
  const items = state.query.set ?? [];
  // Validate SET/WHERE values against the bound schema and verify the filter-matched
  // instances satisfy their constraints; blocks Run on violations.
  useUpdateInstanceGuard();
  // Update INSTANCE binds SET assignments to the MATCH schema (path/property
  // pickers + value), mirroring the read INSTANCE return/filter cards. Other
  // labels keep the free-form expression input.
  const boundSet = state.query.match[0]?.label === "INSTANCE";

  // Changing a node/relationship's attributive_label (or renaming its variable)
  // invalidates any assignment bound to it. Reset such assignments so we never
  // compose a SET against a schema/property that no longer exists.
  useEffect(() => {
    if (!boundSet) return;
    const bindings = collectReadMatchPathBindings(state.query);
    items.forEach((item, index) => {
      const pathVariable = (item.path_variable || "").trim();
      if (!pathVariable) return;
      const binding = bindingForVariable(bindings, pathVariable);
      const boundLabel = (item.attributive_label || "").trim();
      // A binding that turned variable-length is stale too: its alias now holds a
      // relationship list, so the assignment target would be invalid Cypher. Same for
      // one whose hop turned "must not exist" — it is no longer bound outside the
      // NOT EXISTS subquery.
      const stale =
        !binding ||
        binding.attributive_label.trim() !== boundLabel ||
        binding.variableLength === true ||
        binding.unbound === true;
      if (stale) {
        patchQuery(
          updateSetItem(index, {
            path_variable: undefined,
            attributive_label: undefined,
            property_key: undefined,
            entity_role: undefined,
            value: undefined,
            value_mode: undefined,
            source_variable: undefined,
            source_property: undefined,
            expression: ""
          })
        );
        return;
      }
      // not_property rows also depend on their source alias: reset the right-hand
      // side when that alias disappears or turns variable-length.
      const sourceVariable = (item.source_variable || "").trim();
      if (item.value_mode === "not_property" && sourceVariable) {
        const sourceBinding = bindingForVariable(bindings, sourceVariable);
        if (
          !sourceBinding ||
          sourceBinding.variableLength === true ||
          sourceBinding.unbound === true
        ) {
          patchQuery(
            updateSetItem(index, {
              source_variable: undefined,
              source_property: undefined,
              expression: ""
            })
          );
        }
      }
    });
  }, [boundSet, state.query, items, patchQuery]);

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Set (update)</h3>
        <button
          type="button"
          className="builderTinyBtn builderAddBtn"
          onClick={() => patchQuery(addSetItem())}
        >
          + assignment
        </button>
      </div>

      {items.map((item, index) =>
        boundSet ? (
          <SetProjectionRow
            key={index}
            index={index}
            item={item}
            onRemove={() => patchQuery(removeSetItem(index))}
          />
        ) : (
          <div className="builderItemRow" key={index}>
            <div className="builderField">
              <label>expression</label>
              <input
                className="builderMono"
                placeholder="n.name = $name"
                value={item.expression}
                onChange={(e) => patchQuery(updateSetItem(index, { expression: e.target.value }))}
              />
            </div>
            <div className="builderRowActions">
              <button
                type="button"
                className="builderTinyBtn builderDanger"
                onClick={() => patchQuery(removeSetItem(index))}
              >
                Remove
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );
}
