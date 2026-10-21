import {
  OPERATION_ASSIGNMENT_TYPES,
  OPERATION_ASSIGNMENT_WHENS,
  OPERATION_COLLISIONS,
  OPERATION_JUNCTIONS,
  OPERATION_OPERATORS,
  emptyOperationAssignment,
  emptyOperationGroup,
  emptyOperationStatement,
  isUnaryOperationOperator,
  type OperationAssignment,
  type OperationAssignmentType,
  type OperationAssignmentWhen,
  type OperationCollision,
  type OperationEvaluation,
  type OperationJunction,
  type OperationOperand,
  type OperationOperator
} from "@pona-flow/authoring";

const OPERATOR_LABELS: Record<OperationOperator, string> = {
  "=": "equals",
  "<>": "not equals",
  "<": "less than",
  "<=": "less or equal",
  ">": "greater than",
  ">=": "greater or equal",
  CONTAINS: "contains",
  "STARTS WITH": "starts with",
  "ENDS WITH": "ends with",
  EXISTS: "exists",
  "IS EMPTY": "is empty",
  REGEX: "matches regex"
};

const WHEN_LABELS: Record<OperationAssignmentWhen, string> = {
  true: "TRUE",
  false: "FALSE",
  always: "ALWAYS"
};

interface OperationStepConfigProps {
  evaluation: OperationEvaluation;
  assignments: OperationAssignment[];
  warnings: string[];
  onChange: (patch: {
    operation_evaluation?: OperationEvaluation;
    operation_assignments?: OperationAssignment[];
  }) => void;
}

function operandText(value: OperationOperand | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function parseOperand(raw: string): OperationOperand {
  return raw;
}

export function OperationStepConfig({
  evaluation,
  assignments,
  warnings,
  onChange
}: OperationStepConfigProps) {
  function commitEvaluation(next: OperationEvaluation) {
    onChange({ operation_evaluation: next });
  }

  function commitAssignments(next: OperationAssignment[]) {
    onChange({ operation_assignments: next });
  }

  function updateStatement(
    groupIndex: number,
    statementIndex: number,
    patch: Partial<OperationEvaluation["groups"][number]["statements"][number]>
  ) {
    const groups = evaluation.groups.map((group, gi) => {
      if (gi !== groupIndex) return group;
      return {
        ...group,
        statements: group.statements.map((statement, si) =>
          si === statementIndex ? { ...statement, ...patch } : statement
        )
      };
    });
    commitEvaluation({ ...evaluation, groups });
  }

  return (
    <div className="builderBlock">
      <div className="builderField">
        <label>
          evaluation name
          {warnings.length > 0 ? (
            <span className="builderCheckMsg error">{warnings[0]}</span>
          ) : null}
        </label>
        <input
          className="builderMono"
          data-testid="builder-operation-name"
          placeholder="account_tier_routing"
          value={evaluation.name}
          onChange={(e) => commitEvaluation({ ...evaluation, name: e.target.value })}
        />
        <span className="createSequenceHint">
          Written into the run as a boolean. $name and $name.field read parameters already in the run.
        </span>
      </div>
      <div className="builderRow">
        <div className="builderField">
          <label>collision</label>
          <select
            data-testid="builder-operation-collision"
            value={evaluation.collision}
            onChange={(e) =>
              commitEvaluation({
                ...evaluation,
                collision: e.target.value as OperationCollision
              })
            }
          >
            {OPERATION_COLLISIONS.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
          <span className="createSequenceHint">
            overwrite replaces, skip keeps the current value, append adds on, sequence uses key_2, key_3, and so on.
          </span>
        </div>
        <div className="builderField">
          <label>group junction</label>
          <select
            data-testid="builder-operation-group-junction"
            value={evaluation.group_junction}
            onChange={(e) =>
              commitEvaluation({
                ...evaluation,
                group_junction: e.target.value as OperationJunction
              })
            }
          >
            {OPERATION_JUNCTIONS.map((junction) => (
              <option key={junction} value={junction}>
                {junction}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="builderField">
        <label>groups</label>
        <div className="builderBlock" style={{ gap: 8 }}>
          {evaluation.groups.map((group, groupIndex) => (
            <div className="builderCard nested" key={groupIndex}>
              <div className="builderField">
                <label>statement junction</label>
                <select
                  data-testid={`builder-operation-statement-junction-${groupIndex}`}
                  value={group.statement_junction}
                  onChange={(e) => {
                    const groups = evaluation.groups.map((item, index) =>
                      index === groupIndex
                        ? { ...item, statement_junction: e.target.value as OperationJunction }
                        : item
                    );
                    commitEvaluation({ ...evaluation, groups });
                  }}
                >
                  {OPERATION_JUNCTIONS.map((junction) => (
                    <option key={junction} value={junction}>
                      {junction}
                    </option>
                  ))}
                </select>
              </div>
              {group.statements.map((statement, statementIndex) => {
                const unary = isUnaryOperationOperator(statement.operator);
                return (
                  <div className="builderCard nested builderItemRow" key={statementIndex}>
                    <div className="builderField">
                      <label>X</label>
                      <input
                        className="builderMono"
                        data-testid={`builder-operation-x-${groupIndex}-${statementIndex}`}
                        placeholder="$user.email"
                        value={operandText(statement.x)}
                        onChange={(e) =>
                          updateStatement(groupIndex, statementIndex, {
                            x: parseOperand(e.target.value)
                          })
                        }
                      />
                    </div>
                    <div className="builderField">
                      <label>operator</label>
                      <select
                        data-testid={`builder-operation-operator-${groupIndex}-${statementIndex}`}
                        value={statement.operator}
                        onChange={(e) => {
                          const operator = e.target.value as OperationOperator;
                          updateStatement(groupIndex, statementIndex, {
                            operator,
                            y: isUnaryOperationOperator(operator) ? undefined : statement.y ?? ""
                          });
                        }}
                      >
                        {OPERATION_OPERATORS.map((operator) => (
                          <option key={operator} value={operator}>
                            {OPERATOR_LABELS[operator]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {unary ? null : (
                      <div className="builderField">
                        <label>Y</label>
                        <input
                          className="builderMono"
                          data-testid={`builder-operation-y-${groupIndex}-${statementIndex}`}
                          placeholder="@corp.example.com"
                          value={operandText(statement.y)}
                          onChange={(e) =>
                            updateStatement(groupIndex, statementIndex, {
                              y: parseOperand(e.target.value)
                            })
                          }
                        />
                      </div>
                    )}
                    <div className="builderRowActions">
                      <button
                        type="button"
                        className="builderTinyBtn builderDanger"
                        onClick={() => {
                          const groups = evaluation.groups.map((item, index) =>
                            index === groupIndex
                              ? {
                                  ...item,
                                  statements: item.statements.filter((_, si) => si !== statementIndex)
                                }
                              : item
                          );
                          commitEvaluation({ ...evaluation, groups });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="builderCardFooter">
                <button
                  type="button"
                  className="builderTinyBtn builderAddBtn"
                  onClick={() => {
                    const groups = evaluation.groups.map((item, index) =>
                      index === groupIndex
                        ? { ...item, statements: [...item.statements, emptyOperationStatement()] }
                        : item
                    );
                    commitEvaluation({ ...evaluation, groups });
                  }}
                >
                  + Statement
                </button>
                <button
                  type="button"
                  className="builderTinyBtn builderDanger"
                  onClick={() => {
                    commitEvaluation({
                      ...evaluation,
                      groups: evaluation.groups.filter((_, index) => index !== groupIndex)
                    });
                  }}
                >
                  Remove group
                </button>
              </div>
            </div>
          ))}
          <div className="builderCardFooter">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn"
              data-testid="builder-operation-add-group"
              onClick={() =>
                commitEvaluation({
                  ...evaluation,
                  groups: [...evaluation.groups, emptyOperationGroup()]
                })
              }
            >
              + Group
            </button>
          </div>
        </div>
      </div>

      <div className="builderField">
        <label>assignments</label>
        <p className="builderCheckMsg">
          Each row writes when the evaluation matches If Eval. ALWAYS writes either way. A row that does not match leaves the key as it is.
        </p>
        <div className="builderBlock" style={{ gap: 8 }}>
          {assignments.map((item, index) => (
            <div className="builderCard nested builderItemRow" key={index}>
              <div className="builderField">
                <label>if eval</label>
                <select
                  data-testid={`builder-operation-when-${index}`}
                  value={item.when}
                  onChange={(e) => {
                    const next = assignments.map((row, i) =>
                      i === index ? { ...row, when: e.target.value as OperationAssignmentWhen } : row
                    );
                    commitAssignments(next);
                  }}
                >
                  {OPERATION_ASSIGNMENT_WHENS.map((when) => (
                    <option key={when} value={when}>
                      {WHEN_LABELS[when]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="builderField">
                <label>type</label>
                <select
                  data-testid={`builder-operation-type-${index}`}
                  value={item.type}
                  onChange={(e) => {
                    const type = e.target.value as OperationAssignmentType;
                    const value = type === "boolean" ? false : type === "number" ? 0 : "";
                    const next = assignments.map((row, i) =>
                      i === index ? { ...row, type, value } : row
                    );
                    commitAssignments(next);
                  }}
                >
                  {OPERATION_ASSIGNMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="builderField">
                <label>key</label>
                <input
                  className="builderMono"
                  data-testid={`builder-operation-key-${index}`}
                  placeholder="has_seniority"
                  value={item.key}
                  onChange={(e) => {
                    const next = assignments.map((row, i) =>
                      i === index ? { ...row, key: e.target.value } : row
                    );
                    commitAssignments(next);
                  }}
                />
              </div>
              <div className="builderField">
                <label>value</label>
                {item.type === "boolean" ? (
                  <select
                    data-testid={`builder-operation-value-${index}`}
                    value={item.value === true ? "true" : "false"}
                    onChange={(e) => {
                      const next = assignments.map((row, i) =>
                        i === index ? { ...row, value: e.target.value === "true" } : row
                      );
                      commitAssignments(next);
                    }}
                  >
                    <option value="true">TRUE</option>
                    <option value="false">FALSE</option>
                  </select>
                ) : (
                  <input
                    className="builderMono"
                    data-testid={`builder-operation-value-${index}`}
                    type={item.type === "number" ? "number" : "text"}
                    placeholder={item.type === "number" ? "12" : "High"}
                    value={
                      item.type === "number" && typeof item.value === "number" && !Number.isFinite(item.value)
                        ? ""
                        : operandText(item.value)
                    }
                    onChange={(e) => {
                      const raw = e.target.value;
                      const value = item.type === "number" ? (raw === "" ? Number.NaN : Number(raw)) : raw;
                      const next = assignments.map((row, i) => (i === index ? { ...row, value } : row));
                      commitAssignments(next);
                    }}
                  />
                )}
              </div>
              <div className="builderRowActions">
                <button
                  type="button"
                  className="builderTinyBtn builderDanger"
                  onClick={() => commitAssignments(assignments.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="builderCardFooter">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn"
              data-testid="builder-operation-add-assignment"
              onClick={() => commitAssignments([...assignments, emptyOperationAssignment()])}
            >
              + Assignment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
