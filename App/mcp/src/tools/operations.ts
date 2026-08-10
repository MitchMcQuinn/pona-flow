/**
 * Operation authoring tools.
 *
 * An "operation" is a saved catalog package (one read/create/update/delete against the
 * graph) that the engine wraps in a STEP node so it can be composed into a sequence.
 * Saving one is a multi-call choreography — code resources, catalog row, STEP wrap,
 * optional sequence — which lives in @pona-flow/authoring and is shared with the React
 * builder, so an agent-authored operation opens in the visual builder unchanged.
 */

import {
  assertPreflightClear,
  collectCreateEntityIds,
  runCreate,
  saveQueryOperation,
  updateQueryOperation,
  type AuthoringContext,
  type BuilderConfig,
  type QueryObject,
} from "@pona-flow/authoring";
import { connector } from "@pona-flow/connector";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSpaceId, type McpConfig } from "../config.js";
import { buildOperationQuery, mintedIdCount, type OperationIntent } from "../intent.js";
import { guard } from "../result.js";

const responseParameterSchema = z.object({
  property_path: z.string().describe("Dot path into the response body, e.g. data.id."),
  parameter: z.string().describe("Parameter name the extracted value is bound to."),
  default_value: z.string().optional(),
});

const intentSchema = {
  operation: z
    .enum(["read", "create", "update", "delete"])
    .describe("What the package does to the graph."),
  node_label: z
    .enum(["STEP", "SCHEMA", "INSTANCE"])
    .describe(
      "Primary node label. SCHEMA defines a property contract, INSTANCE is data satisfying " +
        "one, STEP is an executable unit (a custom endpoint or code)."
    ),
  attributive_label: z
    .string()
    .optional()
    .describe(
      "UPPER_SNAKE name of the primary node. Globally unique across STEP and SCHEMA — call " +
        "describe_space first. For INSTANCE it names the SCHEMA being instantiated."
    ),
  schema_properties: z
    .array(
      z.object({
        key: z.string(),
        value_type: z
          .enum([
            "string",
            "number",
            "integer",
            "boolean",
            "array",
            "UID",
            "radio",
            "checkbox",
            "attributive label",
          ])
          .optional(),
        format: z.string().optional().describe("Named regex format; 'any' when unconstrained."),
        is_required: z.boolean().optional(),
        is_key: z.boolean().optional().describe("Value must be unique across instances."),
        is_label: z.boolean().optional().describe("Used as the instance's display name."),
        is_indexed: z.boolean().optional(),
        default_value: z.string().optional(),
        options: z.array(z.string()).optional().describe("Choices for radio/checkbox."),
      })
    )
    .optional()
    .describe("Property contract. Only meaningful when creating a SCHEMA."),
  instance_properties: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe(
      "Property values for a new INSTANCE. Keys must exist on the SCHEMA named by " +
        "attributive_label; run describe_schema first."
    ),
  http_step: z
    .object({
      endpoint: z.string().describe("Absolute URL the step calls."),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      body: z.record(z.unknown()).optional(),
      headers: z.record(z.unknown()).optional(),
      response_parameters: z.array(responseParameterSchema).optional(),
    })
    .optional()
    .describe("Creates a custom-endpoint STEP node. Mutually exclusive with code_step."),
  code_step: z
    .object({
      resource_name: z.string().describe("Name of the catalog resource holding the script."),
      language: z.enum(["python", "javascript"]).optional(),
      code: z.string(),
      response_parameters: z.array(responseParameterSchema).optional(),
    })
    .optional()
    .describe("Creates a code-execution STEP node. Mutually exclusive with http_step."),
  where: z
    .array(
      z.object({
        property_key: z.string(),
        operator: z
          .enum([
            "=",
            "<>",
            ">",
            ">=",
            "<",
            "<=",
            "CONTAINS",
            "STARTS WITH",
            "ENDS WITH",
            "IS NULL",
            "IS NOT NULL",
          ])
          .optional(),
        value: z.string().optional().describe("Literal, or $parameter to bind at run time."),
      })
    )
    .optional()
    .describe("Filters on the matched node. Ignored for create."),
  return_items: z
    .array(z.object({ expression: z.string(), alias: z.string().optional() }))
    .optional()
    .describe("Projection for a read, e.g. { expression: 'n1.name' }."),
  set_expressions: z
    .array(z.string())
    .optional()
    .describe("Assignments for an update, e.g. \"n1.status = $status\"."),
  delete_targets: z
    .array(z.string())
    .optional()
    .describe("Variables to DETACH DELETE; defaults to the matched node."),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        value_type: z.string().optional(),
        value: z.string().optional().describe("Default value."),
        is_required: z.boolean().optional(),
      })
    )
    .optional()
    .describe("Run-time inputs, referenced elsewhere as $name."),
  limit: z.number().int().positive().optional(),
};

const rawQueryArg = {
  query: z
    .record(z.unknown())
    .optional()
    .describe(
      "Escape hatch: a complete QueryObject, used verbatim instead of the intent arguments. " +
        "Prefer the intent arguments; use this only for shapes they cannot express, such as " +
        "multi-hop paths. Get a valid example from get_operation's builder_config."
    ),
};

/** Ids are minted by the API so they match the format the rest of the catalog uses. */
async function mintIds(count: number): Promise<{ queryId: string; entityIds: string[] }> {
  const [queryId, ...entityIds] = await Promise.all(
    Array.from({ length: count + 1 }, () => connector.generateQueryId())
  );
  return { queryId, entityIds };
}

function asQueryObject(raw: Record<string, unknown>): QueryObject {
  const query = raw as unknown as QueryObject;
  if (!query || typeof query !== "object" || !Array.isArray(query.match)) {
    throw new Error("`query` must be a QueryObject with a `match` array.");
  }
  return query;
}

export function registerOperationTools(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "create_operation",
    {
      title: "Create operation",
      description:
        "Save a new operation to the catalog and auto-wrap it in a STEP node so it can be " +
        "used in a sequence. Describe the package with the intent arguments; the server " +
        "assembles the QueryObject, validates it, and resolves name collisions. " +
        "Set execute=true when the package should also run now — a create package only " +
        "materializes its SCHEMA/INSTANCE/STEP nodes in the graph when it runs.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "Operation name, also the attributive_label of the wrapping STEP node. " +
              "A numeric suffix is appended if it is already taken."
          ),
        description: z.string().optional(),
        group_title: z.string().optional().describe("Navigation group to file this under."),
        runtime_enabled: z
          .boolean()
          .optional()
          .describe("Whether the operation may run inside a sequence. Defaults to true."),
        add_as_sequence: z
          .boolean()
          .optional()
          .describe("Also wrap the STEP node in a runnable one-step sequence."),
        execute: z
          .boolean()
          .optional()
          .describe("Run the package after saving it. Only valid for create packages."),
        space_id: z.string().optional(),
        ...intentSchema,
        ...rawQueryArg,
      },
    },
    async (args) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, args.space_id);
        const intent = args as unknown as OperationIntent;
        const { queryId, entityIds } = await mintIds(
          args.query ? 0 : mintedIdCount(intent)
        );
        const query = args.query
          ? asQueryObject(args.query)
          : buildOperationQuery({ ...intent, name: args.name }, { queryId, entityIds });

        const ctx: AuthoringContext = {
          spaceId,
          query,
          runtimeEnabled: args.runtime_enabled ?? true,
        };
        await assertPreflightClear(ctx);

        const saved = await saveQueryOperation(ctx, {
          name: args.name,
          runtimeEnabled: ctx.runtimeEnabled,
          addAsSequence: args.add_as_sequence,
          groupTitle: args.group_title,
          description: args.description,
        });

        let executed: Record<string, unknown> | undefined;
        if (args.execute) {
          if (query.operation !== "create") {
            throw new Error(
              `The operation was saved as ${saved.id}, but execute=true only applies to create packages.`
            );
          }
          executed = await runCreate(ctx);
        }

        return {
          ok: true,
          operation_id: saved.id,
          sequence_id: saved.sequenceId ?? null,
          step_attributive_label: args.name,
          created_entity_ids: collectCreateEntityIds(query),
          executed: executed ? true : false,
        };
      })
  );

  server.registerTool(
    "update_operation",
    {
      title: "Update operation",
      description:
        "Recompile and overwrite a saved operation in place. The stored builder_config is the " +
        "starting point, so omitted intent arguments keep their current values only when you " +
        "pass `query`; supplying intent arguments rebuilds the package from scratch while " +
        "preserving the operation id and the graph ids of the entities it creates. " +
        "The wrapping STEP node and any sequences referencing it are untouched.",
      inputSchema: {
        operation_id: z.string().describe("Catalog id from list_operations."),
        name: z.string().optional(),
        description: z.string().optional(),
        group_title: z.string().optional(),
        runtime_enabled: z.boolean().optional(),
        space_id: z.string().optional(),
        ...intentSchema,
        // A rebuild is all-or-nothing, so these two are what signal one is intended.
        operation: intentSchema.operation.optional(),
        node_label: intentSchema.node_label.optional(),
        ...rawQueryArg,
      },
    },
    async (args) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, args.space_id);
        const operationId = args.operation_id;
        const pkg = await connector.fetchQueryPackage(operationId);
        const stored = pkg.builder_config as unknown as BuilderConfig | undefined;
        const base = stored?.query;

        const rebuilding = Boolean(args.operation && args.node_label);
        if (!args.query && !rebuilding && !base) {
          throw new Error(
            `Operation ${operationId} has no stored builder_config, so there is nothing to edit ` +
              "incrementally. Pass a full `query`, or the operation and node_label intent arguments."
          );
        }

        let query: QueryObject;
        if (args.query) {
          query = asQueryObject(args.query);
        } else if (rebuilding) {
          const intent = args as unknown as OperationIntent;
          query = buildOperationQuery(
            { ...intent, name: args.name ?? base?.name ?? "" },
            {
              queryId: operationId,
              // Reuse the existing graph ids so an edit updates the same nodes.
              entityIds: base ? collectCreateEntityIds(base) : [],
            }
          );
        } else {
          query = { ...(base as QueryObject) };
        }
        query.id = operationId;
        if (args.name) query.name = args.name.trim();

        const ctx: AuthoringContext = {
          spaceId,
          query,
          runtimeEnabled: args.runtime_enabled ?? stored?.runtimeEnabled ?? true,
          matchPositions: stored?.matchPositions,
        };
        // Uniqueness probes would flag the operation's own entities as collisions on a
        // rebuild, so only the structural rules apply here; the server enforces the rest.
        const result = await updateQueryOperation(ctx);
        if (args.description !== undefined) {
          await connector.updateQueryDescription({
            spaceId,
            queryId: operationId,
            description: args.description,
          });
        }
        return { ok: true, operation_id: result.id };
      })
  );
}
