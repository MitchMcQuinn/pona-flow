import { useEffect } from "react";
import { useBuilder } from "../../state/builder/BuilderContext";
import {
  addReturnItem,
  countMatchNodes,
  removeReturnItem,
  setReadTraversal,
  setReturnDistinct,
  updateReturnItem
} from "../../state/builder/queryHelpers";
import {
  bindingForVariable,
  collectReadMatchPathBindings,
  isReturnFieldParameter
} from "@pona-flow/authoring";
import { ReadReturnProjectionRow } from "./ReadReturnProjectionRow";
import { Toggle } from "./Toggle";

// Read STEP/SCHEMA: a single-node match returns the node's downstream or full
// network as a path; more than one node hides the card entirely.
function TraversalReturnSection() {
  const { state, patchQuery, createSequenceMode } = useBuilder();
  if (countMatchNodes(state.query) !== 1) return null;
  const mode = state.query.read_traversal;

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Return</h3>
      </div>
      <div className="builderReturnTraversal">
        <Toggle
          checked={mode === "downstream"}
          onChange={(value) => patchQuery(setReadTraversal(value ? "downstream" : undefined))}
          label="Return downstream"
          labelFirst
        />
        {/* Sequences only expose the downstream traversal; the full-network option is
            reserved for ad-hoc read STEP/SCHEMA queries. */}
        {!createSequenceMode ? (
          <Toggle
            checked={mode === "network"}
            onChange={(value) => patchQuery(setReadTraversal(value ? "network" : undefined))}
            label="Return network"
            labelFirst
          />
        ) : null}
      </div>
    </section>
  );
}

export function ReturnSection() {
  const { state, patchQuery } = useBuilder();
  const ret = state.query.return ?? { distinct: false, items: [] };
  const op = state.query.operation;
  const label = state.query.match[0]?.label;
  const distinctInAdvanced = op === "read";

  // INSTANCE read/update use the schema-bound projection card; other flows keep
  // the free-form expression/alias rows.
  const boundReadReturn = label === "INSTANCE" && (op === "read" || op === "update");

  // Changing a node/relationship's attributive_label (or renaming its variable)
  // invalidates any schema-bound projection that referenced it. Reset such
  // projections so we never compose a RETURN against a stale schema/property.
  // Parameter schemas have no binding and are intentionally left untouched.
  useEffect(() => {
    if (!boundReadReturn) return;
    const bindings = collectReadMatchPathBindings(state.query);
    ret.items.forEach((item, index) => {
      const pathVariable = (item.path_variable || "").trim();
      if (!pathVariable || isReturnFieldParameter(pathVariable)) return;
      const binding = bindingForVariable(bindings, pathVariable);
      const boundLabel = (item.attributive_label || "").trim();
      // A binding that turned variable-length is stale too: its alias now holds a
      // relationship list, so the alias.prop projection would be invalid Cypher.
      const stale =
        !binding ||
        binding.attributive_label.trim() !== boundLabel ||
        binding.variableLength === true;
      if (stale) {
        patchQuery(
          updateReturnItem(index, {
            path_variable: undefined,
            attributive_label: undefined,
            property_key: undefined,
            entity_role: undefined,
            boolean_mode: undefined,
            comparison_operator: undefined,
            comparison_value: undefined,
            expression: "",
            alias: undefined
          })
        );
      }
    });
  }, [boundReadReturn, state.query, ret.items, patchQuery]);

  if (op === "read" && (label === "STEP" || label === "SCHEMA")) {
    return <TraversalReturnSection />;
  }

  return (
    <section className="builderSection">
      <div className="builderHeadRow">
        <h3 style={{ margin: 0 }}>Return</h3>
        <div className="builderInline">
          {!distinctInAdvanced ? (
            <Toggle
              checked={ret.distinct ?? false}
              onChange={(value) => patchQuery(setReturnDistinct(value))}
              label="DISTINCT"
            />
          ) : null}
          <button
            type="button"
            className="builderTinyBtn builderAddBtn"
            onClick={() => patchQuery(addReturnItem())}
          >
            + projection
          </button>
        </div>
      </div>

      {ret.items.length === 0 ? (
        <p className="builderCheckMsg">
          {boundReadReturn
            ? "Empty RETURN emits `RETURN *`. Add projections to return specific properties."
            : "Empty RETURN emits `RETURN *`."}
        </p>
      ) : null}

      {ret.items.map((item, index) =>
        boundReadReturn ? (
          <ReadReturnProjectionRow
            key={index}
            index={index}
            item={item}
            onRemove={() => patchQuery(removeReturnItem(index))}
          />
        ) : (
          <div className="builderItemRow" key={index}>
            <div className="builderRow">
              <div className="builderField">
                <label>expression</label>
                <input
                  className="builderMono"
                  placeholder="n"
                  value={item.expression}
                  onChange={(e) =>
                    patchQuery(updateReturnItem(index, { expression: e.target.value }))
                  }
                />
              </div>
              <div className="builderField">
                <label>alias (optional)</label>
                <input
                  className="builderMono"
                  value={item.alias ?? ""}
                  onChange={(e) =>
                    patchQuery(updateReturnItem(index, { alias: e.target.value || undefined }))
                  }
                />
              </div>
            </div>
            <div className="builderRowActions">
              <button
                type="button"
                className="builderTinyBtn builderDanger"
                onClick={() => patchQuery(removeReturnItem(index))}
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
