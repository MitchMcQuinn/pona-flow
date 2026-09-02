/**
 * Sequence persistence.
 *
 * A sequence is a catalog row (`kind='sequence'`, read, triggerable) whose Cypher matches
 * the STEP subgraph to traverse. It therefore can only be saved after the STEP nodes it
 * matches already exist — see the assembly ordering documented in Docs/MCP-AUTHORING.md.
 */

import { composer } from "@pona-flow/composer";
import { connector } from "@pona-flow/connector";
import { oneStepSequenceBuilderConfig, serializeBuilderConfig } from "./builderConfig.js";
import { normalizeLoopConfig } from "./loopRules.js";
import { normalizeForCompose } from "./normalize.js";
import { cypherStatementsForExecution, type QueriesCatalogPayload } from "./packages.js";
import {
  autoWrapInStep,
  maybeRetargetSequenceWrap,
  resolveStepWrapAttributiveLabel
} from "./stepWrapLabel.js";
import type { AuthoringContext, LoopConfig } from "./types.js";

export interface SequenceInput {
  id: string;
  name: string;
  groupTitle: string;
  description?: string;
  /**
   * Termination rule for the one cycle in the sequence's STEP graph. Omitted (or
   * `type: "dag"`) leaves the executor on its single-pass walk, so a back-edge
   * simply ends the run.
   */
  loop?: LoopConfig;
}

/** Result of saving or updating a sequence catalog row. */
export interface SequencePackageResult {
  id: string;
  /**
   * True when the wrapping STEP node's attributive_label was SET to the new title.
   * False when the title saved but the wrap stayed put (label taken, or no wrap exists).
   */
  wrapRetargeted?: boolean;
  /** Current wrapping STEP attributive_label after the save, if a wrap exists. */
  wrapLabel?: string;
}

/**
 * Wrap an auto-created STEP node in a one-step sequence (catalog kind=sequence, read,
 * triggerable). The sequence's read Cypher matches the wrapping STEP node by its
 * attributive_label, so a lone operation becomes runnable as a sequence without any
 * manual sequence-building step. `groupTitle` files the sequence under a navigation
 * group (the upsert endpoint registers it on the space).
 */
export async function autoWrapInSequence(
  spaceId: string,
  name: string,
  groupTitle?: string,
  description?: string
): Promise<SequencePackageResult> {
  const cypher = composer.composeOneStepSequenceCypher({ name });
  if (!cypher) return { id: "" };
  const sequenceId = await connector.generateQueryId();
  const payload: QueriesCatalogPayload = {
    id: sequenceId,
    name: name.trim(),
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: groupTitle?.trim() || undefined,
    space_id: spaceId || undefined,
    cypher: [cypher],
    sqlite: [],
    parameters: [],
    description: description?.trim() || undefined,
    // The auto-wrapped sequence never passes through the visual builder, so synthesize the
    // matching STEP-by-attributive_label snapshot here; otherwise it persists an empty
    // builder_config and can't be opened in the create-sequence editor.
    builder_config: oneStepSequenceBuilderConfig(sequenceId, name)
  };
  await connector.upsertQuery(payload);
  return { id: sequenceId };
}

/** Persist a navigation sequence (kind=sequence, read, triggerable) to the catalog. */
export async function saveSequencePackage(
  ctx: AuthoringContext,
  input: SequenceInput
): Promise<SequencePackageResult> {
  if (!ctx.spaceId) {
    throw new Error("Select a space before creating a sequence.");
  }
  const query = normalizeForCompose(ctx.query);
  const composed = composer.composeQuery(query);
  const id = input.id.trim();
  const wrapName = await resolveStepWrapAttributiveLabel(ctx.spaceId, input.name);
  const payload: QueriesCatalogPayload = {
    id,
    name: wrapName,
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: input.groupTitle.trim() || undefined,
    space_id: ctx.spaceId || undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: [],
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: input.description?.trim() || undefined,
    // Declarative builder snapshot so the sequence can be round-tripped back into the
    // create-sequence builder for visual editing (the composer is forward-only).
    builder_config: serializeBuilderConfig(ctx, true),
    loop_config: normalizeLoopConfig(input.loop)
  };
  const { id: sequenceId } = await connector.upsertQuery(payload);
  await autoWrapInStep(ctx.spaceId, sequenceId, payload.name);
  return { id: sequenceId, wrapRetargeted: true, wrapLabel: payload.name };
}

/**
 * Update an existing saved sequence in place: recompile the edited STEP-chain read query and
 * overwrite the catalog row (cypher/parameters + builder_config), keeping the same id.
 *
 * The catalog `name` is the workspace title (nav, MCP tool title) and always saves. The
 * wrapping STEP attributive_label follows that title only when the name is free in the
 * graph; otherwise the wrap stays put so MATCH Cypher and nested identity stay valid.
 * The sequence's own MATCH is never rewritten from the title — it still names the entry STEP.
 */
export async function updateSequencePackage(
  ctx: AuthoringContext,
  input: SequenceInput
): Promise<SequencePackageResult> {
  if (!ctx.spaceId) {
    throw new Error("Select a space before editing a sequence.");
  }
  const query = normalizeForCompose(ctx.query);
  const composed = composer.composeQuery(query);
  const id = input.id.trim();
  const title = input.name.trim();
  const payload: QueriesCatalogPayload = {
    id,
    name: title,
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: input.groupTitle.trim() || undefined,
    space_id: ctx.spaceId || undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: [],
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: input.description?.trim() || undefined,
    builder_config: serializeBuilderConfig(ctx, true),
    loop_config: normalizeLoopConfig(input.loop)
  };
  const { id: sequenceId } = await connector.upsertQuery(payload);
  const wrap = await maybeRetargetSequenceWrap(ctx.spaceId, sequenceId, title);
  return {
    id: sequenceId,
    wrapRetargeted: wrap.retargeted,
    wrapLabel: wrap.wrapLabel
  };
}
