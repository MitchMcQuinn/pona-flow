import { useBuilder } from "../../../state/builder/BuilderContext";
import type {
  CypherConditionBuilder,
  CypherConditionPredicate,
  RelationshipPattern
} from "../../../state/builder/types";

const OPERATORS: CypherConditionPredicate["operator"][] = [
  "=",
  "<>",
  ">",
  ">=",
  "<",
  "<=",
  "CONTAINS",
  "STARTS WITH",
  "ENDS WITH",
  "IS NULL",
  "IS NOT NULL"
];

interface RelConditionConfigProps {
  relationship: RelationshipPattern;
  onPatch: (patch: Partial<RelationshipPattern>) => void;
}

export function RelConditionConfig({ relationship, onPatch }: RelConditionConfigProps) {
  const { state } = useBuilder();
  const conditionType = relationship.condition_type ?? "null";
  const builder: CypherConditionBuilder = relationship.cypher_condition ?? {
    combine: "AND",
    predicates: []
  };

  function setPredicates(predicates: CypherConditionPredicate[]) {
    onPatch({ cypher_condition: { combine: builder.combine, predicates } });
  }

  return (
    <div className="builderCard nested">
      <div className="builderField">
        <label>Relationship condition</label>
        <select
          value={conditionType}
          onChange={(e) =>
            onPatch({ condition_type: e.target.value as RelationshipPattern["condition_type"] })
          }
        >
          <option value="null">none</option>
          <option value="implicit">implicit (natural language)</option>
          <option value="cypher">cypher (INSTANCE EXISTS)</option>
        </select>
      </div>

      {conditionType === "implicit" ? (
        <div className="builderField">
          <label>condition</label>
          <input
            value={relationship.condition ?? ""}
            onChange={(e) => onPatch({ condition: e.target.value })}
          />
        </div>
      ) : null}

      {conditionType === "cypher" ? (
        <>
          <div className="builderRow">
            <div className="builderField">
              <label>combine</label>
              <select
                value={builder.combine}
                onChange={(e) =>
                  onPatch({
                    cypher_condition: {
                      combine: e.target.value as "AND" | "OR",
                      predicates: builder.predicates
                    }
                  })
                }
              >
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
            </div>
          </div>
          <div className="builderRowActions">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn"
              onClick={() =>
                setPredicates([...builder.predicates, { property: "", operator: "=", value: "" }])
              }
            >
              + predicate
            </button>
          </div>

          {builder.predicates.map((pred, index) => {
            const usingParam = pred.parameter !== undefined;
            const noValue = pred.operator === "IS NULL" || pred.operator === "IS NOT NULL";
            const update = (patch: Partial<CypherConditionPredicate>) =>
              setPredicates(builder.predicates.map((p, i) => (i === index ? { ...p, ...patch } : p)));
            return (
              <div className="builderItemRow" key={index}>
                <div className="builderRow">
                  <div className="builderField">
                    <label>property</label>
                    <input
                      className="builderMono"
                      placeholder="property"
                      value={pred.property}
                      onChange={(e) => update({ property: e.target.value })}
                    />
                  </div>
                  <div className="builderField">
                    <label>operator</label>
                    <select
                      value={pred.operator}
                      onChange={(e) =>
                        update({ operator: e.target.value as CypherConditionPredicate["operator"] })
                      }
                    >
                      {OPERATORS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!noValue ? (
                    usingParam ? (
                      <div className="builderField">
                        <label>parameter</label>
                        <select
                          value={pred.parameter ?? ""}
                          onChange={(e) => update({ parameter: e.target.value, value: undefined })}
                        >
                          <option value="">(parameter)</option>
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
                          placeholder="value"
                          value={String(pred.value ?? "")}
                          onChange={(e) => update({ value: e.target.value })}
                        />
                      </div>
                    )
                  ) : null}
                </div>
                <div className="builderRowActions">
                  {!noValue ? (
                    <button
                      type="button"
                      className="builderTinyBtn"
                      onClick={() =>
                        update(
                          usingParam
                            ? { parameter: undefined, value: "" }
                            : { value: undefined, parameter: state.query.parameters[0]?.name ?? "" }
                        )
                      }
                    >
                      {usingParam ? "use literal" : "use param"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="builderTinyBtn builderDanger"
                    onClick={() => setPredicates(builder.predicates.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
