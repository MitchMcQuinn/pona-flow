import { useEffect } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  addUnwindItem,
  setUnwindAlias,
  updateUnwindItem
} from "../../state/builder/queryHelpers";
import {
  bindingForVariable,
  collectReadMatchPathBindings,
  isReturnFieldParameter,
  normalizeAlias,
  validateOptionalAlias
} from "@pona-flow/authoring";
import { UnwindProjectionRow } from "./UnwindProjectionRow";

export function UnwindSection() {
  const { state, patchQuery } = useBuilder();
  const unwind = state.query.unwind;
  const items = unwind?.items ?? [];
  const alias = unwind?.alias ?? "";
  const aliasError = validateOptionalAlias(alias);

  useEffect(() => {
    const bindings = collectReadMatchPathBindings(state.query);
    items.forEach((item, index) => {
      const pathVariable = (item.path_variable || "").trim();
      if (!pathVariable || isReturnFieldParameter(pathVariable)) return;
      const binding = bindingForVariable(bindings, pathVariable);
      const boundLabel = (item.attributive_label || "").trim();
      const stale =
        !binding ||
        binding.attributive_label.trim() !== boundLabel ||
        binding.variableLength === true;
      if (stale) {
        patchQuery(
          updateUnwindItem(index, {
            path_variable: undefined,
            attributive_label: undefined,
            property_key: undefined,
            entity_role: undefined,
            expression: ""
          })
        );
      }
    });
  }, [state.query, items, patchQuery]);

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Unwind into rows</h3>
        <div className="builderInline">
          <button
            type="button"
            className="builderTinyBtn builderAddBtn"
            onClick={() => patchQuery(addUnwindItem())}
          >
            + value
          </button>
        </div>
      </div>
      <p className="builderCheckMsg">
        Stack several properties into rows under one name. MATCH aliases stay unique;
        a for/each loop iterates the stacked column.
      </p>
      {items.length === 0 ? (
        <p className="muted">
          Empty UNWIND is omitted. Add at least two values (e.g. subject id and object id).
        </p>
      ) : null}
      {items.map((item, index) => (
        <UnwindProjectionRow key={index} index={index} item={item} />
      ))}
      {items.length > 0 ? (
        <div className="builderField">
          <label>
            column alias
            {aliasError ? <span className="builderCheckMsg error">{aliasError}</span> : null}
          </label>
          <input
            className="builderMono"
            placeholder="entityId"
            value={alias}
            onChange={(e) => patchQuery(setUnwindAlias(normalizeAlias(e.target.value)))}
          />
        </div>
      ) : null}
    </section>
  );
}
