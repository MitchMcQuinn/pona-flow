/**
 * Operation STEP authoring helpers.
 *
 * An operation step evaluates a two-level boolean against the current run's
 * parameters and writes that boolean plus typed assignment literals back into
 * the same run. It does not read the graph and it does not read credentials.
 */

import { isValidParameterName } from "./stepBodyParams.js";
import type {
  OperationAssignment,
  OperationAssignmentType,
  OperationAssignmentWhen,
  OperationCollision,
  OperationEvaluation,
  OperationGroup,
  OperationJunction,
  OperationOperand,
  OperationOperator,
  OperationStatement,
  SequencialProperties
} from "./types.js";

export const OPERATION_JUNCTIONS: readonly OperationJunction[] = ["AND", "OR"];
export const OPERATION_COLLISIONS: readonly OperationCollision[] = [
  "overwrite",
  "skip",
  "append",
  "sequence"
];
export const OPERATION_OPERATORS: readonly OperationOperator[] = [
  "=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "CONTAINS",
  "STARTS WITH",
  "ENDS WITH",
  "EXISTS",
  "IS EMPTY",
  "REGEX"
];
export const OPERATION_ASSIGNMENT_WHENS: readonly OperationAssignmentWhen[] = [
  "true",
  "false",
  "always"
];
export const OPERATION_ASSIGNMENT_TYPES: readonly OperationAssignmentType[] = [
  "boolean",
  "string",
  "number"
];

const UNARY_OPERATORS = new Set<OperationOperator>(["EXISTS", "IS EMPTY"]);
const OPERAND_REF_RE = /^\$(?!secret(?:\.|$))[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/i;
const SECRET_REF_RE = /^\$secret(?:\.|$)/i;

export function isOperationStep(sp: SequencialProperties | null | undefined): boolean {
  return Boolean(sp && sp.query_id === undefined && sp.step_type === "operation");
}

export function isUnaryOperationOperator(operator: string): boolean {
  return UNARY_OPERATORS.has(operator as OperationOperator);
}

export function emptyOperationStatement(): OperationStatement {
  return { x: "", operator: "=", y: "" };
}

export function emptyOperationGroup(): OperationGroup {
  return { statement_junction: "AND", statements: [emptyOperationStatement()] };
}

export function defaultOperationEvaluation(): OperationEvaluation {
  return {
    name: "",
    collision: "overwrite",
    group_junction: "AND",
    groups: [emptyOperationGroup()]
  };
}

export function emptyOperationAssignment(): OperationAssignment {
  return { when: "true", type: "string", key: "", value: "", collision: "overwrite" };
}

function operandWarnings(label: string, raw: OperationOperand | undefined, required: boolean): string[] {
  if (raw === undefined || raw === null) {
    return required ? [`${label} is required.`] : [];
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? [] : [`${label} must be a finite number.`];
  }
  if (typeof raw === "boolean") return [];
  const text = String(raw).trim();
  if (!text) return required ? [`${label} is required.`] : [];
  if (!text.startsWith("$")) return [];
  if (SECRET_REF_RE.test(text)) {
    return [`${label} cannot read credentials ($secret).`];
  }
  if (!OPERAND_REF_RE.test(text)) {
    return [`${label} must be a literal or a $parameter (optionally .field).`];
  }
  return [];
}

function assignmentValueWarnings(item: OperationAssignment): string[] {
  const value = item.value;
  if (typeof value === "string" && value.trim().startsWith("$")) {
    return ["Assignment values are literals, not $parameters."];
  }
  if (item.type === "boolean") {
    return typeof value === "boolean" ? [] : ["Boolean assignments need a true or false value."];
  }
  if (item.type === "string") {
    return typeof value === "string" ? [] : ["String assignments need a text value."];
  }
  if (item.type === "number") {
    if (typeof value === "boolean" || typeof value !== "number" || !Number.isFinite(value)) {
      return ["Number assignments need a finite number."];
    }
    return [];
  }
  return ["Assignment type must be boolean, string, or number."];
}

/**
 * Shape problems the builder can see on its own. Empty array = complete enough to save.
 */
export function operationStepWarnings(sp: SequencialProperties | null | undefined): string[] {
  if (!isOperationStep(sp) || !sp) return [];
  const warnings: string[] = [];
  const evaluation = sp.operation_evaluation;
  const name = String(evaluation?.name ?? "").trim();
  if (!name) {
    warnings.push("Evaluation name is required.");
  } else if (!isValidParameterName(name)) {
    warnings.push("Evaluation name must be a parameter name (letter or underscore, then letters, digits, or underscores).");
  }
  const collision = evaluation?.collision;
  if (!collision || !(OPERATION_COLLISIONS as readonly string[]).includes(collision)) {
    warnings.push("Collision must be overwrite, skip, append, or sequence.");
  }
  const groupJunction = evaluation?.group_junction;
  if (groupJunction !== "AND" && groupJunction !== "OR") {
    warnings.push("Group junction must be AND or OR.");
  }
  const groups = evaluation?.groups ?? [];
  if (groups.length === 0) {
    warnings.push("An operation needs at least one group.");
  }
  groups.forEach((group, groupIndex) => {
    const where = `Group ${groupIndex + 1}`;
    if (group.statement_junction !== "AND" && group.statement_junction !== "OR") {
      warnings.push(`${where} statement junction must be AND or OR.`);
    }
    const statements = group.statements ?? [];
    if (statements.length === 0) {
      warnings.push(`${where} needs at least one statement.`);
    }
    statements.forEach((statement, statementIndex) => {
      const at = `${where} statement ${statementIndex + 1}`;
      if (!(OPERATION_OPERATORS as readonly string[]).includes(statement.operator)) {
        warnings.push(`${at} has an unknown operator.`);
        return;
      }
      warnings.push(...operandWarnings(`${at} X`, statement.x, true));
      if (!isUnaryOperationOperator(statement.operator)) {
        warnings.push(...operandWarnings(`${at} Y`, statement.y, false));
        if (statement.y === undefined || statement.y === null) {
          warnings.push(`${at} needs a Y value.`);
        }
      }
    });
  });

  (sp.operation_assignments ?? []).forEach((item, index) => {
    const at = `Assignment ${index + 1}`;
    if (!(OPERATION_ASSIGNMENT_WHENS as readonly string[]).includes(item.when)) {
      warnings.push(`${at} If Eval must be true, false, or always.`);
    }
    const key = String(item.key ?? "").trim();
    if (!key) {
      warnings.push(`${at} key is required.`);
    } else if (!isValidParameterName(key)) {
      warnings.push(`${at} key must be a parameter name.`);
    }
    const assignmentCollision = item.collision ?? collision;
    if (
      !assignmentCollision ||
      !(OPERATION_COLLISIONS as readonly string[]).includes(assignmentCollision)
    ) {
      warnings.push(`${at} collision must be overwrite, skip, append, or sequence.`);
    }
    warnings.push(...assignmentValueWarnings(item).map((message) => `${at}: ${message}`));
  });

  return warnings;
}
