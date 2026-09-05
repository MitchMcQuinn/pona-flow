/**
 * Pre-write validation, including the checks that need the server.
 *
 * `validateQuery` is pure and catches structural problems. The uniqueness invariants —
 * attributive labels are globally unique across STEP and SCHEMA nodes (STEP-to-STEP
 * POINTS_TO edges may reuse NEXT), graph ids are unique, an INSTANCE is_key value may
 * not repeat — can only be settled by asking the graph. In the React builder those
 * probes run continuously as debounced field checks and gate the Run button through
 * `checksAllClear`. Any other client (the MCP server) would otherwise write straight
 * past them, so the same probes are folded into one awaitable call here.
 */

import { connector } from "@pona-flow/connector";
import { attributiveLabelRequiresUniqueness } from "./attributiveLabels.js";
import { ATTRIBUTIVE_LABEL_VALUE_TYPE } from "./parameterRefs.js";
import type { AuthoringContext, NodePattern, RelationshipPattern } from "./types.js";
import { catalogRuntimeEnabled, validateQuery } from "./validation.js";

interface LabelProbe {
  attributiveLabel: string;
  nodeLabel?: string;
  describe: string;
}

function createdEntities(
  ctx: AuthoringContext
): Array<{ clauseLabel: string; entity: NodePattern | RelationshipPattern; isNode: boolean }> {
  const out: Array<{
    clauseLabel: string;
    entity: NodePattern | RelationshipPattern;
    isNode: boolean;
  }> = [];
  for (const clause of ctx.query.match ?? []) {
    for (const pattern of clause.patterns ?? []) {
      for (const el of pattern.path ?? []) {
        if (el.kind === "node") {
          if (el.node.alias_mode === "reference" || el.node.node_source === "existing") continue;
          out.push({ clauseLabel: clause.label, entity: el.node, isNode: true });
        } else {
          if (el.relationship.alias_mode === "reference") continue;
          if (el.relationship.node_source === "existing") continue;
          out.push({ clauseLabel: clause.label, entity: el.relationship, isNode: false });
        }
      }
    }
  }
  return out;
}

/**
 * Validate a context and resolve every server-backed uniqueness check.
 * Returns human-readable warnings; an empty array means the write is safe to attempt.
 */
export async function preflight(ctx: AuthoringContext): Promise<string[]> {
  const warnings = validateQuery(ctx.query, catalogRuntimeEnabled(ctx.query, ctx.runtimeEnabled));
  const spaceId = ctx.spaceId;
  if (!spaceId) {
    warnings.push("A space is required.");
    return warnings;
  }
  if (ctx.query.operation !== "create") return warnings;

  const labelProbes: LabelProbe[] = [];
  const idProbes: Array<{ id: string; describe: string }> = [];
  const keyProbes: Array<{
    attributiveLabel: string;
    propertyKey: string;
    value: string;
    describe: string;
  }> = [];

  for (const { clauseLabel, entity, isNode } of createdEntities(ctx)) {
    const attributiveLabel = (entity.attributive_label || "").trim();
    // STEP/SCHEMA nodes and SCHEMA relationship types share one global namespace.
    // STEP-to-STEP POINTS_TO edges do not (NEXT may repeat). INSTANCE labels name
    // their SCHEMA and are expected to already exist.
    if (attributiveLabel && attributiveLabelRequiresUniqueness(clauseLabel, isNode)) {
      labelProbes.push({
        attributiveLabel,
        nodeLabel: isNode ? clauseLabel : undefined,
        describe: `${clauseLabel} ${isNode ? "node" : "relationship"} "${attributiveLabel}"`,
      });
    }
    const idValue = String(entity.id_binding?.value ?? "").trim();
    if (idValue && !idValue.startsWith("$")) {
      idProbes.push({ id: idValue, describe: `${clauseLabel} id "${idValue}"` });
    }
    if (clauseLabel === "INSTANCE" && attributiveLabel) {
      for (const prop of entity.properties ?? []) {
        if (!prop.schematic_properties?.is_key) continue;
        const key = (prop.key || "").trim();
        const value = String(prop.value ?? "").trim();
        if (!key || !value || value.startsWith("$")) continue;
        keyProbes.push({
          attributiveLabel,
          propertyKey: key,
          value,
          describe: `INSTANCE key "${key}" value "${value}"`,
        });
      }
    }
  }

  for (const param of ctx.query.parameters ?? []) {
    if (param.schematic_properties?.value_type !== ATTRIBUTIVE_LABEL_VALUE_TYPE) continue;
    const value = String(param.value ?? "").trim();
    if (!value) continue;
    labelProbes.push({
      attributiveLabel: value,
      describe: `parameter "$${param.name}" default attributive_label "${value}"`,
    });
  }

  const [labelHits, idHits, keyHits] = await Promise.all([
    Promise.all(
      labelProbes.map((probe) =>
        connector.checkAttributiveLabelExists({
          spaceId,
          attributiveLabel: probe.attributiveLabel,
          nodeLabel: probe.nodeLabel,
        })
      )
    ),
    Promise.all(idProbes.map((probe) => connector.checkGraphIdExists({ spaceId, id: probe.id }))),
    Promise.all(
      keyProbes.map((probe) =>
        connector.checkInstancePropertyExists({
          spaceId,
          attributiveLabel: probe.attributiveLabel,
          propertyKey: probe.propertyKey,
          value: probe.value,
        })
      )
    ),
  ]);

  labelHits.forEach((exists, i) => {
    if (exists) warnings.push(`${labelProbes[i].describe} is already taken — choose another.`);
  });
  idHits.forEach((exists, i) => {
    if (exists) warnings.push(`${idProbes[i].describe} already exists in the graph.`);
  });
  keyHits.forEach((exists, i) => {
    if (exists) warnings.push(`${keyProbes[i].describe} is already taken — choose another.`);
  });

  return warnings;
}

/** Run `preflight` and throw a single combined error when anything is wrong. */
export async function assertPreflightClear(ctx: AuthoringContext): Promise<void> {
  const warnings = await preflight(ctx);
  if (warnings.length) {
    throw new Error(warnings.join(" "));
  }
}
