/**
 * Builder -> authoring adapter.
 *
 * All of the save/create/update choreography lives in @pona-flow/authoring so the MCP
 * server can drive it headlessly. This module's only job is to project the React
 * `BuilderState` down to the narrow `AuthoringContext` the authoring package accepts, and
 * to keep the builder's existing import surface stable.
 */

import {
  runCreate as authoringRunCreate,
  runQuery as authoringRunQuery,
  saveQueryOperation as authoringSaveQueryOperation,
  saveSequencePackage as authoringSaveSequencePackage,
  updateQueryOperation as authoringUpdateQueryOperation,
  updateSequencePackage as authoringUpdateSequencePackage,
  type AuthoringContext,
  type SaveOperationInput,
  type SequenceInput,
} from "@pona-flow/authoring";
import type { BuilderState, RunResult } from "../state/builder/types";

export {
  buildCreateBody,
  buildCreateBodyWithOptions,
  buildQueriesCatalogPayload,
  createResponseToRunResult,
  cypherStatementsForExecution,
  entitySqliteStatements,
  persistCodeResources,
  resaveOperationFromConfig,
  runReadCypher,
  type QueriesCatalogPayload,
  type SaveOperationInput,
} from "@pona-flow/authoring";

/** Narrow the React state down to what the authoring package actually reads. */
export function authoringContext(state: BuilderState): AuthoringContext {
  return {
    spaceId: state.spaceId ?? "",
    query: state.query,
    runtimeEnabled: state.runtimeEnabled,
    matchPositions: state.matchPositions,
  };
}

export async function runCreate(state: BuilderState): Promise<Record<string, unknown>> {
  return authoringRunCreate(authoringContext(state));
}

export async function runQuery(state: BuilderState): Promise<RunResult> {
  return authoringRunQuery(authoringContext(state));
}

export async function saveQueryOperation(
  state: BuilderState,
  input: SaveOperationInput
): Promise<{ id: string; sequenceId?: string }> {
  return authoringSaveQueryOperation(authoringContext(state), input);
}

export async function updateQueryOperation(state: BuilderState): Promise<{ id: string }> {
  return authoringUpdateQueryOperation(authoringContext(state));
}

export async function saveSequencePackage(
  state: BuilderState,
  input: SequenceInput
): Promise<{ id: string }> {
  return authoringSaveSequencePackage(authoringContext(state), input);
}

export async function updateSequencePackage(
  state: BuilderState,
  input: SequenceInput
): Promise<{ id: string }> {
  return authoringUpdateSequencePackage(authoringContext(state), input);
}
