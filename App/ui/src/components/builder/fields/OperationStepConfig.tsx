import { Fragment } from "react";
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
  isValidParameterName,
  type OperationAssignment,
  type OperationAssignmentType,
  type OperationAssignmentWhen,
  type OperationCollision,
  type OperationEvaluation,
  type OperationJunction,
  type OperationOperand,
  type OperationOperator
} from "@pona-flow/authoring";
import { FieldLabel, FieldTip } from "../FieldTip";

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

function JunctionDivider({ value }: { value: OperationJunction }) {
  return (
    <div className="builderJunctionDivider" aria-hidden="true">
      <span>{value}</span>
    </div>
  );
}

function StatementJunctionField({
  groupIndex,
  value,
  onChange
}: {
  groupIndex: number;
  value: OperationJunction;
  onChange: (next: OperationJunction) => void;
}) {
  return (
    <div className="builderField builderJunctionField">
      <FieldLabel>statement junction</FieldLabel>
      <select
        data-testid={`builder-operation-statement-junction-${groupIndex}`}
        value={value}
        onChange={(e) => onChange(e.target.value as OperationJunction)}
      >
        {OPERATION_JUNCTIONS.map((junction) => (
          <option key={junction} value={junction}>
            {junction}
          </option>
        ))}
      </select>
    </div>
  );
}

function CardRemove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="builderPropertyRemove"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path
          d="M2 2 L10 10 M10 2 L2 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

export function OperationStepConfig({
  evaluation,
  assignments,
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
      <div
        className={
          isValidParameterName(evaluation.name.trim())
            ? "builderField builderPropertyName"
            : "builderField builderFieldMissing builderPropertyName"
        }
      >
        <div className="createSequenceNameRow">
          <input
            className="builderPropertyNameInput"
            aria-label="evaluation name"
            data-testid="builder-operation-name"
            placeholder="Enter an evaluation name"
            value={evaluation.name}
            onChange={(e) => commitEvaluation({ ...evaluation, name: e.target.value })}
          />
          <FieldTip text="Written into the run as a boolean. $name and $name.field read parameters already in the run." />
        </div>
      </div>
      <div className="builderField">
        {evaluation.groups.length > 1 ? (
          <div className="builderField builderJunctionField">
            <FieldLabel>condition junction</FieldLabel>
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
        ) : null}
        <div className="builderOperationConditionHead">
          <h2 className="builderPanelTitle">condition</h2>
          {evaluation.groups.length === 1 && evaluation.groups[0].statements.length > 1 ? (
            <StatementJunctionField
              groupIndex={0}
              value={evaluation.groups[0].statement_junction}
              onChange={(statement_junction) =>
                commitEvaluation({
                  ...evaluation,
                  groups: [{ ...evaluation.groups[0], statement_junction }]
                })
              }
            />
          ) : null}
        </div>
        <div className="builderBlock">
          <div className="builderOperationConditions">
          {evaluation.groups.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              {groupIndex > 0 ? <JunctionDivider value={evaluation.group_junction} /> : null}
              <div
                className={
                  evaluation.groups.length > 1
                    ? "builderStackCard builderOperationGroup builderParameterCardRemovable"
                    : "builderStackCard builderOperationGroup"
                }
              >
              {evaluation.groups.length > 1 ? (
                <div className="builderOperationGroupHead">
                  {group.statements.length > 1 ? (
                    <StatementJunctionField
                      groupIndex={groupIndex}
                      value={group.statement_junction}
                      onChange={(statement_junction) => {
                        const groups = evaluation.groups.map((item, index) =>
                          index === groupIndex ? { ...item, statement_junction } : item
                        );
                        commitEvaluation({ ...evaluation, groups });
                      }}
                    />
                  ) : null}
                  <CardRemove
                    label="Remove condition"
                    onClick={() =>
                      commitEvaluation({
                        ...evaluation,
                        groups: evaluation.groups.filter((_, index) => index !== groupIndex)
                      })
                    }
                  />
                </div>
              ) : null}
              <div className="builderOperationStatements">
                {group.statements.map((statement, statementIndex) => {
                  const unary = isUnaryOperationOperator(statement.operator);
                  return (
                    <Fragment key={statementIndex}>
                      {statementIndex > 0 ? (
                        <JunctionDivider value={group.statement_junction} />
                      ) : null}
                      <div
                        className={
                          group.statements.length > 1
                            ? "builderCard nested builderItemRow builderParameterCard builderParameterCardRemovable"
                            : "builderCard nested builderItemRow builderParameterCard"
                        }
                      >
                      {group.statements.length > 1 ? (
                        <CardRemove
                          label="Remove statement"
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
                        />
                      ) : null}
                      <div className="builderInlineRow builderStatementRow">
                        <div className="builderField">
                          <input
                            className="builderMono"
                            aria-label="X"
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
                        <div className="builderField builderInlineRowOperator">
                          <div
                            className="builderOperatorSelect"
                            data-value={OPERATOR_LABELS[statement.operator]}
                          >
                            <select
                              aria-label="operator"
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
                        </div>
                        {unary ? null : (
                          <div className="builderField">
                            <input
                              className="builderMono"
                              aria-label="Y"
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
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
              </div>
              <div className="builderCardFooter">
                <button
                  type="button"
                  className="builderTinyBtn builderAddBtn builderAddParameterBtn"
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
              </div>
            </div>
            </Fragment>
          ))}
          </div>
          <div className="builderCardFooter">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn builderAddParameterBtn"
              data-testid="builder-operation-add-group"
              onClick={() =>
                commitEvaluation({
                  ...evaluation,
                  groups: [...evaluation.groups, emptyOperationGroup()]
                })
              }
            >
              + Condition
            </button>
          </div>
        </div>
      </div>

      <div className="builderField builderOperationAssignments">
        <div className="createSequenceLabelRow">
          <h2 className="builderPanelTitle">assignments</h2>
          <FieldTip text="Each row writes when the condition matches this choice. ALWAYS writes either way. A row that does not match leaves the key as it is." />
        </div>
        <div className="builderBlock">
          {assignments.map((item, index) => (
            <div
              className={
                assignments.length > 1
                  ? "builderCard nested builderItemRow builderParameterCard builderParameterCardRemovable"
                  : "builderCard nested builderItemRow builderParameterCard"
              }
              key={index}
            >
              {assignments.length > 1 ? (
                <CardRemove
                  label="Remove assignment"
                  onClick={() => commitAssignments(assignments.filter((_, i) => i !== index))}
                />
              ) : null}
              <div className="builderAssignmentFields">
              <div className="builderPropertyTypeRow">
                <div className="builderField">
                  <FieldLabel>if condition is...</FieldLabel>
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
                  <FieldLabel>type</FieldLabel>
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
                  <FieldLabel tip="overwrite replaces, skip keeps the current value, append adds on, sequence uses key_2, key_3, and so on.">
                    collision
                  </FieldLabel>
                  <select
                    data-testid={`builder-operation-collision-${index}`}
                    value={item.collision ?? evaluation.collision}
                    onChange={(e) => {
                      const next = assignments.map((row, i) =>
                        i === index
                          ? { ...row, collision: e.target.value as OperationCollision }
                          : row
                      );
                      commitAssignments(next);
                    }}
                  >
                    {OPERATION_COLLISIONS.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="builderPropertyTypeRow">
                <div className="builderField">
                  <FieldLabel>key</FieldLabel>
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
                  <FieldLabel>value</FieldLabel>
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
              </div>
              </div>
            </div>
          ))}
          <div className="builderCardFooter">
            <button
              type="button"
              className="builderTinyBtn builderAddBtn builderAddParameterBtn"
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
