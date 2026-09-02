/**
 * STEP wiring and sequence authoring.
 *
 * These tools are ordering-sensitive in a way that is easy to get wrong: a sequence's read
 * Cypher matches STEP nodes by attributive_label at run time, and `create_step_transition`
 * attaches to STEP nodes by graph id, so both require their nodes to already exist. Create
 * the operations first (each auto-wraps a STEP node), then the transitions, then the
 * sequence. The server `instructions` string states this too.
 */

import {
  assertPreflightClear,
  runCreate,
  saveSequencePackage,
  updateSequencePackage,
  type AuthoringContext,
  type BuilderConfig,
  type QueryObject,
} from "@pona-flow/authoring";
import { connector } from "@pona-flow/connector";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSpaceId, type McpConfig } from "../config.js";
import {
  buildLoopConfig,
  buildSequenceQuery,
  buildStepTransitionQuery,
  type LoopIntent,
} from "../intent.js";
import { guard } from "../result.js";

/**
 * The `loop` argument shared by create_sequence and update_sequence.
 *
 * Worth spelling out for an agent, because the split is not obvious: the *cycle* is drawn
 * with create_step_transition (an edge from a later STEP back to an earlier one), and this
 * only decides when that cycle stops. Neither half works alone — a loop type with no
 * back-edge is rejected at compose, and a back-edge with no loop type just ends the run.
 */
const loopSchema = z
  .object({
    type: z
      .enum(["dag", "for", "for_while", "for_each"])
      .describe(
        "'dag' (default) runs each step once, so a back-edge ends the run. 'for' makes a " +
          "fixed number of passes. 'for_while' tests a condition before each pass. " +
          "'for_each' makes one pass per row of a result set. The three looping types " +
          "require the STEP graph to contain exactly one cycle."
      ),
    count: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("for: how many passes. Zero skips the looped steps entirely."),
    condition: z
      .object({
        parameter: z
          .string()
          .describe(
            "A sequence/step parameter, or a RETURN alias one of the steps projects " +
              "(those are bound into run state automatically)."
          ),
        operator: z.enum(["=", "<>", "<", "<=", ">", ">=", "CONTAINS", "STARTS WITH", "ENDS WITH"]),
        value: z.string(),
      })
      .optional()
      .describe(
        "for_while: tested before every pass including the first, so an already-false " +
          "condition skips the looped steps. An unresolved parameter reads as false."
      ),
    source: z
      .string()
      .optional()
      .describe(
        "for_each: the RETURN alias whose rows are iterated. Each pass binds that row's " +
          "columns under their aliases, so the looped steps see one row at a time. Put the " +
          "step that projects it *outside* the cycle, or an empty result cannot skip the body."
      ),
    max_iterations: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Safety cap (default 1000). Exceeding it fails the run."),
  })
  .optional();

/** Resolve a STEP node's graph id from its attributive_label, failing with a usable hint. */
async function stepIdForLabel(spaceId: string, attributiveLabel: string): Promise<string> {
  const label = attributiveLabel.trim();
  const nodes = await connector.fetchGraphNodesByLabel({
    spaceId,
    nodeLabel: "STEP",
    attributiveLabel: label,
  });
  const match = nodes.find((node) => node.attributive_label === label);
  if (!match) {
    throw new Error(
      `No STEP node named "${label}" exists in this space. ` +
        "Create the operation that wraps it first, or call list_step_nodes to see what exists."
    );
  }
  return match.id;
}

export function registerSequenceTools(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "create_step_transition",
    {
      title: "Wire two STEP nodes",
      description:
        "Create a POINTS_TO edge from one STEP node to another, so a sequence that reaches " +
        "the first step continues to the second. Both STEP nodes must already exist. " +
        "Unlike create_operation this writes to the graph immediately rather than saving a " +
        "reusable package. Attach a condition to make the transition conditional: the branch " +
        "fires only when the condition holds, so two edges out of one step form a branch.",
      inputSchema: {
        from_step: z.string().describe("attributive_label of the source STEP node."),
        to_step: z.string().describe("attributive_label of the target STEP node."),
        relationship_label: z
          .string()
          .describe("UPPER_SNAKE name for the edge, e.g. ON_APPROVAL. Describes why it fires."),
        condition_type: z
          .enum(["null", "parameter", "cypher", "implicit", "query"])
          .optional()
          .describe(
            "'null' always fires (default). 'parameter' gates on a boolean parameter — the " +
              "usual way to branch. 'cypher' gates on an INSTANCE EXISTS predicate, " +
              "'implicit' on a natural-language condition, 'query' on a referenced query."
          ),
        condition: z
          .string()
          .optional()
          .describe("The gating expression, interpreted per condition_type."),
        condition_expected: z
          .boolean()
          .optional()
          .describe(
            "For a 'parameter' condition, the boolean the parameter must equal. Use true on " +
              "one edge and false on its sibling to branch on a single parameter."
          ),
        space_id: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, args.space_id);
        const [fromId, toId, queryId, relId] = await Promise.all([
          stepIdForLabel(spaceId, args.from_step),
          stepIdForLabel(spaceId, args.to_step),
          connector.generateQueryId(),
          connector.generateQueryId(),
        ]);

        const query = buildStepTransitionQuery(
          {
            from: { id: fromId, attributive_label: args.from_step.trim() },
            to: { id: toId, attributive_label: args.to_step.trim() },
            relationship_label: args.relationship_label,
            condition: args.condition,
            condition_type: args.condition_type,
            condition_expected: args.condition_expected,
          },
          { queryId, entityIds: [relId] }
        );

        const ctx: AuthoringContext = { spaceId, query, runtimeEnabled: false };
        await assertPreflightClear(ctx);
        await runCreate(ctx);
        return {
          ok: true,
          from_step: args.from_step,
          to_step: args.to_step,
          relationship_id: relId,
          relationship_label: args.relationship_label,
        };
      })
  );

  server.registerTool(
    "create_sequence",
    {
      title: "Create sequence",
      description:
        "Save a runnable sequence starting at an existing STEP node. By default the sequence " +
        "runs the entry step and everything downstream of it via POINTS_TO, so build the STEP " +
        "chain with create_step_transition before calling this. The sequence becomes a " +
        "callable tool on the space's runtime MCP gateway, and its description is what an " +
        "agent sees, so write it for a reader who does not know this graph. " +
        "Each step runs once unless `loop` selects a termination rule for a cycle in the " +
        "chain — use that to repeat steps, e.g. once per row a read step returned.",
      inputSchema: {
        entry_step: z
          .string()
          .describe("attributive_label of the STEP node the sequence starts at."),
        name: z
          .string()
          .describe("Sequence name. A numeric suffix is appended if it is already taken."),
        group_title: z.string().describe("Navigation group the sequence is filed under."),
        description: z.string().optional().describe("Prose shown to agents calling this."),
        traversal: z
          .enum(["downstream", "single"])
          .optional()
          .describe(
            "'downstream' (default) runs the whole POINTS_TO chain; 'single' runs only the " +
              "entry step even when it has outgoing edges."
          ),
        parameters: z
          .array(
            z.object({
              name: z.string(),
              value_type: z.string().optional(),
              value: z.string().optional(),
              is_required: z.boolean().optional(),
            })
          )
          .optional()
          .describe("Inputs collected before the run and bound as $name inside the steps."),
        loop: loopSchema,
        space_id: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, args.space_id);
        await stepIdForLabel(spaceId, args.entry_step);
        const sequenceId = await connector.generateQueryId();
        const query = buildSequenceQuery({
          id: sequenceId,
          entry_step: args.entry_step,
          traversal: args.traversal === "single" ? "single" : "downstream",
          parameters: args.parameters,
        });
        const ctx: AuthoringContext = { spaceId, query, runtimeEnabled: true };
        const saved = await saveSequencePackage(ctx, {
          id: sequenceId,
          name: args.name,
          groupTitle: args.group_title,
          description: args.description,
          loop: buildLoopConfig(args.loop),
        });
        return { ok: true, sequence_id: saved.id, entry_step: args.entry_step };
      })
  );

  server.registerTool(
    "update_sequence",
    {
      title: "Update sequence",
      description:
        "Overwrite a saved sequence in place, keeping its id. Use this to change the " +
        "workspace title, the entry step, the traversal mode, the parameters, the loop " +
        "rule, or the description. The wrapping STEP label follows a new title only when " +
        "that name is free in the graph; otherwise the title still saves. Editing the " +
        "steps themselves is done with create_step_transition and update_operation — the " +
        "sequence only names where the run starts and when it stops.",
      inputSchema: {
        sequence_id: z.string().describe("Catalog id from list_operations(kind='sequence')."),
        name: z
          .string()
          .optional()
          .describe(
            "Workspace title (nav and MCP tool title). The wrapping STEP attributive_label " +
              "is updated to match only when this name is not already used in the graph."
          ),
        entry_step: z.string().optional().describe("New entry STEP attributive_label."),
        group_title: z.string().optional(),
        description: z.string().optional(),
        traversal: z.enum(["downstream", "single"]).optional(),
        parameters: z
          .array(
            z.object({
              name: z.string(),
              value_type: z.string().optional(),
              value: z.string().optional(),
              is_required: z.boolean().optional(),
            })
          )
          .optional(),
        loop: loopSchema,
        query: z
          .record(z.unknown())
          .optional()
          .describe("Escape hatch: a complete read QueryObject used verbatim."),
        space_id: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, args.space_id);
        const pkg = await connector.fetchQueryPackage(args.sequence_id);
        const stored = pkg.builder_config as unknown as BuilderConfig | undefined;

        let query: QueryObject;
        if (args.query) {
          query = args.query as unknown as QueryObject;
        } else if (args.entry_step || args.traversal || args.parameters) {
          const entryStep = args.entry_step ?? entryStepFrom(stored?.query, pkg.cypher);
          if (!entryStep) {
            throw new Error(
              `Could not determine the entry step of ${args.sequence_id}. Pass entry_step explicitly.`
            );
          }
          if (args.entry_step) await stepIdForLabel(spaceId, args.entry_step);
          query = buildSequenceQuery({
            id: args.sequence_id,
            entry_step: entryStep,
            traversal:
              args.traversal ??
              (stored?.query?.read_traversal === "downstream" ? "downstream" : "single"),
            parameters: args.parameters,
          });
        } else if (stored?.query) {
          query = stored.query;
        } else {
          throw new Error(
            `Sequence ${args.sequence_id} has no stored builder_config. Pass entry_step or query.`
          );
        }
        query.id = args.sequence_id;

        const ctx: AuthoringContext = {
          spaceId,
          query,
          runtimeEnabled: true,
          matchPositions: stored?.matchPositions,
        };
        const saved = await updateSequencePackage(ctx, {
          id: args.sequence_id,
          name: args.name?.trim() || pkg.name,
          groupTitle: args.group_title ?? pkg.group_title ?? "",
          description: args.description ?? pkg.description,
          // Omitting `loop` keeps the saved rule — this is a full-row upsert, so an
          // update that only touched the description would otherwise clear it.
          loop: buildLoopConfig(args.loop ?? (pkg.loop_config as LoopIntent | undefined)),
        });
        return {
          ok: true,
          sequence_id: saved.id,
          name: args.name?.trim() || pkg.name,
          wrap_retargeted: saved.wrapRetargeted ?? false,
          wrap_label: saved.wrapLabel || undefined,
        };
      })
  );
}

const STEP_ATTR_LABEL_RE = /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/i;

/** The sequence's entry STEP, from its builder snapshot or, failing that, its saved Cypher. */
function entryStepFrom(query: QueryObject | undefined, cypher: string[] | undefined): string {
  const fromSnapshot = query?.match?.[0]?.patterns?.[0]?.path?.[0];
  if (fromSnapshot?.kind === "node") {
    const label = (fromSnapshot.node.attributive_label || "").trim();
    if (label) return label;
  }
  for (const statement of cypher || []) {
    const match = STEP_ATTR_LABEL_RE.exec(String(statement ?? ""));
    if (match) return match[1].trim();
  }
  return "";
}
