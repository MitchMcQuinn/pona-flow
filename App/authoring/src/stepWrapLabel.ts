import { composer } from "@pona-flow/composer";
import { connector } from "@pona-flow/connector";
import { oneStepSequenceBuilderConfig } from "./builderConfig.js";
import {
  cypherTraversesDownstream,
  sequenceReferencesStepLabel
} from "./sequenceCypher.js";
import { nextUniqueAttributiveLabel, shouldRetargetOperationWrap, shouldRetargetSequenceWrap } from "./uniqueAttributiveLabel.js";

/**
 * Resolve the attributive_label for an auto-wrapped STEP node. When the requested
 * name is already used by another STEP in the graph, append a sequential suffix
 * starting at 1 (FOO -> FOO1). The wrapping entity's own label is excluded so
 * re-saves of the same operation keep their current label when still available.
 */
export async function resolveStepWrapAttributiveLabel(
  spaceId: string,
  baseName: string,
  ownEntityId?: string
): Promise<string> {
  const rows = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" });
  const taken = new Set<string>();
  for (const row of rows) {
    const label = (row.attributive_label || "").trim();
    if (!label) continue;
    if (ownEntityId && row.id === ownEntityId) continue;
    taken.add(label);
  }
  return nextUniqueAttributiveLabel(baseName, taken);
}

/**
 * Auto-create a STEP node (entities row + graph node) that wraps a freshly saved
 * operation or sequence so it is immediately selectable from the operations dropdown
 * in the create STEP flow, eliminating the manual "wrap in a STEP node" step. Both
 * writes are idempotent, so re-saving never produces a duplicate wrapping STEP node.
 */
export async function autoWrapInStep(
  spaceId: string,
  wrappedId: string,
  name: string
): Promise<void> {
  let entityId = "";
  if (spaceId) {
    try {
      entityId = (await connector.fetchStepWrapEntityId({ spaceId, operationId: wrappedId })).trim();
    } catch {
      entityId = "";
    }
  }
  if (!entityId) {
    entityId = await connector.generateQueryId();
  }
  const params = { entityId, operationId: wrappedId, name };
  const sqlite = composer.composeStepWrapEntitySql(params) ?? [];
  const cypher = composer.composeStepWrapGraphCypher(params) ?? [];
  if (!sqlite.length && !cypher.length) return;
  // Register the wrapping STEP node's attributive_label in the active space's labels
  // array (catalog spaces.labels), so it surfaces like any manually created STEP node.
  const attributive_labels = name.trim() ? [name.trim()] : [];
  await connector.executeCreatePackage({
    space_id: spaceId,
    node_label: "STEP",
    cypher,
    sqlite,
    cypher_params: {},
    attributive_labels,
    // The wrap MERGEs a fixed entity id, so re-saving legitimately re-claims its own label.
    attributive_label_owner_ids: [entityId]
  });
}

/** Entity id of the STEP node wrapping a saved operation, or "" when it has none yet. */
export async function stepWrapEntityId(spaceId: string, operationId: string): Promise<string> {
  if (!spaceId) return "";
  try {
    return (await connector.fetchStepWrapEntityId({ spaceId, operationId })).trim();
  } catch {
    return "";
  }
}

export interface SequenceWrapRetargetResult {
  retargeted: boolean;
  wrapLabel: string;
}

/**
 * Follow a sequence title change onto the wrapping STEP node when that label is free.
 *
 * Auto-wrapped one-step sequences have no sequence wrap (the MATCH points at the operation
 * STEP), so this is a no-op for those — the catalog title still changes. A collision with
 * another STEP/SCHEMA leaves the wrap label as-is rather than failing the title save.
 */
export async function maybeRetargetSequenceWrap(
  spaceId: string,
  sequenceId: string,
  requestedName: string
): Promise<SequenceWrapRetargetResult> {
  const name = requestedName.trim();
  const wrapId = await stepWrapEntityId(spaceId, sequenceId);
  if (!wrapId || !name) {
    return { retargeted: false, wrapLabel: "" };
  }
  let current = "";
  try {
    const nodes = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" });
    current = (nodes.find((node) => node.id === wrapId)?.attributive_label || "").trim();
  } catch {
    return { retargeted: false, wrapLabel: "" };
  }
  let taken = true;
  try {
    taken = await connector.checkAttributiveLabelExists({
      spaceId,
      attributiveLabel: name,
      excludeId: wrapId
    });
  } catch {
    return { retargeted: false, wrapLabel: current };
  }
  if (
    !shouldRetargetSequenceWrap({
      requestedName: name,
      wrapEntityId: wrapId,
      currentWrapLabel: current,
      labelTakenByOther: taken
    })
  ) {
    return { retargeted: false, wrapLabel: current };
  }
  try {
    await autoWrapInStep(spaceId, sequenceId, name);
    return { retargeted: true, wrapLabel: name };
  } catch {
    return { retargeted: false, wrapLabel: current };
  }
}

async function syncPairedOneStepSequence(opts: {
  spaceId: string;
  sequenceId: string;
  title: string;
  wrapLabel: string;
  rewriteMatch: boolean;
}): Promise<void> {
  const pkg = await connector.fetchQueryPackage(opts.sequenceId);
  const cypher = opts.rewriteMatch
    ? [composer.composeOneStepSequenceCypher({ name: opts.wrapLabel })].filter(
        (stmt): stmt is string => Boolean(stmt)
      )
    : pkg.cypher;
  const builder_config = opts.rewriteMatch
    ? oneStepSequenceBuilderConfig(opts.sequenceId, opts.wrapLabel)
    : pkg.builder_config;
  await connector.upsertQuery({
    id: opts.sequenceId,
    name: opts.title,
    kind: "sequence",
    operation: "read",
    runtime_enabled: true,
    author_selectable: true,
    triggerable: true,
    group_title: pkg.group_title || undefined,
    space_id: opts.spaceId,
    cypher,
    sqlite: pkg.sqlite ?? [],
    parameters: pkg.parameters ?? [],
    description: pkg.description,
    builder_config,
    loop_config: pkg.loop_config
  });
}

/**
 * Follow an operation title change onto the wrapping STEP when that label is free
 * and no multi-step sequence MATCHES the current wrap label.
 *
 * The paired one-step sequence catalog title always follows the new name. If the wrap
 * retargets, that one-step MATCH / builder_config is rewritten to the new label.
 * Multi-step sequences are never rewritten.
 */
export async function maybeRetargetOperationWrap(
  spaceId: string,
  operationId: string,
  requestedName: string
): Promise<SequenceWrapRetargetResult> {
  const name = requestedName.trim();
  const wrapId = await stepWrapEntityId(spaceId, operationId);
  let current = "";
  if (wrapId) {
    try {
      const nodes = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" });
      current = (nodes.find((node) => node.id === wrapId)?.attributive_label || "").trim();
    } catch {
      current = "";
    }
  }
  const matchLabel = current;
  const rows = await connector.fetchSavedQueries();
  const paired = rows.filter(
    (row) =>
      row.kind === "sequence" &&
      !cypherTraversesDownstream(row.cypher) &&
      sequenceReferencesStepLabel(row.cypher, matchLabel)
  );
  const multiStepReferencesWrap = rows.some(
    (row) =>
      row.kind === "sequence" &&
      cypherTraversesDownstream(row.cypher) &&
      sequenceReferencesStepLabel(row.cypher, matchLabel)
  );
  let taken = true;
  if (wrapId && name) {
    try {
      taken = await connector.checkAttributiveLabelExists({
        spaceId,
        attributiveLabel: name,
        excludeId: wrapId
      });
    } catch {
      taken = true;
    }
  }
  const retarget = shouldRetargetOperationWrap({
    requestedName: name,
    wrapEntityId: wrapId,
    currentWrapLabel: current,
    labelTakenByOther: taken,
    multiStepReferencesWrap
  });
  let wrapLabel = current;
  if (retarget) {
    try {
      await autoWrapInStep(spaceId, operationId, name);
      wrapLabel = name;
    } catch {
      wrapLabel = current;
    }
  }
  const rewriteMatch = Boolean(retarget && wrapLabel === name);
  for (const seq of paired) {
    try {
      await syncPairedOneStepSequence({
        spaceId,
        sequenceId: seq.id,
        title: name,
        wrapLabel: rewriteMatch ? name : matchLabel,
        rewriteMatch
      });
    } catch {
      // Title/cypher sync is best-effort; the operation catalog row already saved.
    }
  }
  return { retargeted: rewriteMatch, wrapLabel };
}
