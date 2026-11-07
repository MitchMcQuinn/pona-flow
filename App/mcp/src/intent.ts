/**
 * Re-export of the authoring intent compiler.
 *
 * The compiler lives in @pona-flow/authoring so the in-app chat and these MCP tools
 * assemble the same QueryObject. This module keeps the historical import path.
 */

export {
  aliasFor,
  buildLoopConfig,
  buildOperationQuery,
  buildSequenceQuery,
  buildStepTransitionQuery,
  mintedIdCount,
  type InstancePropertyIntent,
  type LoopIntent,
  type MintedIds,
  type OperationIntent,
  type ParameterIntent,
  type ReturnIntent,
  type SchemaPropertyIntent,
  type SequenceIntent,
  type StepHttpIntent,
  type StepJoinIntent,
  type StepOperationIntent,
  type StepOperationStatementIntent,
  type StepTransitionIntent,
  type StepWaitIntent,
  type UnwindIntent,
  type WhereIntent,
} from "@pona-flow/authoring";
