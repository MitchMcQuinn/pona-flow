/**
 * Destructive tools, plus the repair tool for partially-written STEP wraps.
 *
 * Deletion in pona flow cascades across three stores that have no shared transaction, so
 * these tools are two-phase: the first call returns the blast radius and a confirmation
 * token, the second call writes. See ../confirm.ts for why the token is bound to a target.
 */

import { autoWrapInStep } from "@pona-flow/authoring";
import { connector } from "@pona-flow/connector";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSpaceId, type McpConfig } from "../config.js";
import { issueConfirmation, redeemConfirmation } from "../confirm.js";
import { guard } from "../result.js";

const confirmArg = {
  confirm_token: z
    .string()
    .optional()
    .describe(
      "Omit on the first call to receive a preview and a token. Pass the returned token to " +
        "perform the deletion. Show the preview to the user before you do."
    ),
};

export function registerDestructiveTools(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "delete_step",
    {
      title: "Delete STEP node",
      description:
        "Remove a STEP node and everything that depends on it: its POINTS_TO edges, the " +
        "operation it wraps, and any sequence that runs through it. Two-phase — the first " +
        "call previews the cascade and returns a confirm_token.",
      inputSchema: {
        attributive_label: z.string().describe("The STEP node's attributive_label."),
        ...confirmArg,
        space_id: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ attributive_label, confirm_token, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        if (!confirm_token) {
          const preview = await connector.previewStepDeletion({
            spaceId,
            attributiveLabel: attributive_label,
          });
          return {
            ok: true,
            confirmed: false,
            preview,
            confirm_token: issueConfirmation("delete_step", spaceId, attributive_label),
          };
        }
        redeemConfirmation(confirm_token, "delete_step", spaceId, attributive_label);
        const result = await connector.executeStepDeletion({
          spaceId,
          attributiveLabel: attributive_label,
        });
        return { ok: true, confirmed: true, result };
      })
  );

  server.registerTool(
    "delete_schema",
    {
      title: "Delete SCHEMA node",
      description:
        "Remove a SCHEMA and cascade to its instances and the operations bound to it. " +
        "Two-phase — the first call previews the cascade and returns a confirm_token. " +
        "The preview's warnings are the part worth reading aloud: this can orphan data.",
      inputSchema: {
        attributive_label: z.string().describe("The SCHEMA node's attributive_label."),
        ...confirmArg,
        space_id: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ attributive_label, confirm_token, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        if (!confirm_token) {
          const preview = await connector.previewSchemaDeletion({
            spaceId,
            attributiveLabel: attributive_label,
          });
          return {
            ok: true,
            confirmed: false,
            preview,
            confirm_token: issueConfirmation("delete_schema", spaceId, attributive_label),
          };
        }
        redeemConfirmation(confirm_token, "delete_schema", spaceId, attributive_label);
        const result = await connector.executeSchemaDeletion({
          spaceId,
          attributiveLabel: attributive_label,
        });
        return { ok: true, confirmed: true, result };
      })
  );

  server.registerTool(
    "delete_operation",
    {
      title: "Delete operation or sequence",
      description:
        "Remove a saved catalog package. A sequence is unlinked from the navigation, leaving " +
        "its STEP nodes intact so other sequences that share them keep working. An operation " +
        "is inseparable from the STEP node wrapping it, so deleting one runs the STEP cascade " +
        "— which is why the preview matters. Two-phase in both cases.",
      inputSchema: {
        operation_id: z.string().describe("Catalog id from list_operations."),
        ...confirmArg,
        space_id: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ operation_id, confirm_token, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const rows = await connector.fetchSavedQueries();
        const row = rows.find((candidate) => candidate.id === operation_id);
        if (!row) throw new Error(`No catalog package with id ${operation_id}.`);

        if (row.kind === "sequence") {
          if (!confirm_token) {
            return {
              ok: true,
              confirmed: false,
              preview: {
                kind: "sequence",
                name: row.name,
                effect:
                  "Removes the sequence's catalog row and composed execution packages. " +
                  "Its STEP nodes and their edges are left in place.",
              },
              confirm_token: issueConfirmation("delete_operation", spaceId, operation_id),
            };
          }
          redeemConfirmation(confirm_token, "delete_operation", spaceId, operation_id);
          const result = await connector.deleteSequenceDefinition({
            spaceId,
            sequenceId: operation_id,
          });
          return { ok: true, confirmed: true, result };
        }

        // An operation's wrapping STEP carries its catalog name as the attributive_label.
        const label = row.name;
        if (!confirm_token) {
          const preview = await connector.previewStepDeletion({
            spaceId,
            attributiveLabel: label,
          });
          return {
            ok: true,
            confirmed: false,
            cascades_through_step: label,
            preview,
            confirm_token: issueConfirmation("delete_operation", spaceId, operation_id),
          };
        }
        redeemConfirmation(confirm_token, "delete_operation", spaceId, operation_id);
        const result = await connector.executeStepDeletion({
          spaceId,
          attributiveLabel: label,
        });
        return { ok: true, confirmed: true, cascades_through_step: label, result };
      })
  );

  server.registerTool(
    "repair_step_wraps",
    {
      title: "Repair STEP wraps",
      description:
        "Find and fix operations whose wrapping STEP node was left half-written. Saving an " +
        "operation touches the catalog database, the per-space SQLite mirror, and Neo4j with " +
        "no transaction across them, so an interrupted save can leave a graph node with no " +
        "entity row — the operation then looks saved but cannot run. Reports what it finds; " +
        "pass apply=true to re-run the wrap for each one.",
      inputSchema: {
        apply: z
          .boolean()
          .optional()
          .describe("Perform the repairs. Defaults to false (report only)."),
        space_id: z.string().optional(),
      },
    },
    async ({ apply, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const [rows, stepNodes] = await Promise.all([
          connector.fetchSavedQueries(),
          connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" }),
        ]);
        const graphLabels = new Map(stepNodes.map((node) => [node.attributive_label, node.id]));

        const broken: Array<{ operation_id: string; name: string; reason: string }> = [];
        for (const row of rows) {
          if (row.kind !== "operation") continue;
          const entityId = await connector.fetchStepWrapEntityId({
            spaceId,
            operationId: row.id,
          });
          const hasEntity = Boolean(entityId.trim());
          const hasGraphNode = graphLabels.has(row.name);
          if (hasEntity && hasGraphNode) continue;
          broken.push({
            operation_id: row.id,
            name: row.name,
            reason: hasGraphNode
              ? "graph node exists but no entity row backs it"
              : hasEntity
                ? "entity row exists but no graph node backs it"
                : "no wrapping STEP node at all",
          });
        }

        if (!apply || !broken.length) {
          return { ok: true, space_id: spaceId, applied: false, broken };
        }
        const repaired: string[] = [];
        const failed: Array<{ operation_id: string; error: string }> = [];
        for (const entry of broken) {
          try {
            await autoWrapInStep(spaceId, entry.operation_id, entry.name);
            repaired.push(entry.operation_id);
          } catch (error) {
            failed.push({
              operation_id: entry.operation_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return { ok: true, space_id: spaceId, applied: true, broken, repaired, failed };
      })
  );
}
