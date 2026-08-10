/**
 * Read-only tools.
 *
 * An agent cannot author against a space it cannot see. These tools exist so the model
 * can discover which attributive labels are taken, which SCHEMAs it may instantiate, and
 * how existing operations are shaped, before it proposes a write. Reading first is also
 * what keeps it from colliding with the global attributive-label namespace.
 */

import { connector } from "@pona-flow/connector";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSpaceId, type McpConfig } from "../config.js";
import { guard } from "../result.js";

const spaceArg = {
  space_id: z
    .string()
    .optional()
    .describe("Target space id. Defaults to PONA_FLOW_SPACE_ID."),
};

export function registerIntrospectionTools(server: McpServer, config: McpConfig): void {
  server.registerTool(
    "list_spaces",
    {
      title: "List spaces",
      description:
        "List every space in the catalog with its id and name. Start here when no space is configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const { spaces } = await connector.fetchSpaces();
        return {
          ok: true,
          default_space_id: config.spaceId || null,
          spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
        };
      })
  );

  server.registerTool(
    "describe_space",
    {
      title: "Describe space",
      description:
        "Connection info, registered attributive labels, and navigation groups for a space. " +
        "The labels list is the namespace new STEP and SCHEMA names must not collide with.",
      inputSchema: spaceArg,
      annotations: { readOnlyHint: true },
    },
    async ({ space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const [connections, labels, groups] = await Promise.all([
          connector.fetchSpaceConnections(spaceId),
          connector.fetchSpaceLabels(spaceId),
          connector.fetchSpaceGroups(spaceId),
        ]);
        return { ok: true, space_id: spaceId, connections, labels, groups };
      })
  );

  server.registerTool(
    "list_operations",
    {
      title: "List operations",
      description:
        "Saved catalog packages. `kind` is 'operation' for a single CRUD package and " +
        "'sequence' for a runnable STEP chain. Filter with the kind argument.",
      inputSchema: {
        kind: z
          .enum(["operation", "sequence", "system", "all"])
          .optional()
          .describe("Catalog kind to include; defaults to all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind }) =>
      guard(async () => {
        const rows = await connector.fetchSavedQueries();
        const wanted = kind && kind !== "all" ? kind : null;
        return {
          ok: true,
          operations: rows
            .filter((row) => !wanted || row.kind === wanted)
            .map((row) => ({
              id: row.id,
              name: row.name,
              kind: row.kind,
              operation: row.operation,
              runtime_enabled: Boolean(row.runtime_enabled),
              suspended: Boolean(row.suspended),
            })),
        };
      })
  );

  server.registerTool(
    "get_operation",
    {
      title: "Get operation",
      description:
        "One saved package in full: composed cypher/sqlite/parameters plus its builder_config " +
        "(the declarative QueryObject snapshot). Pass that snapshot back to update_operation to edit it.",
      inputSchema: {
        operation_id: z.string().describe("Catalog id of the operation or sequence."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operation_id }) =>
      guard(async () => {
        const pkg = await connector.fetchQueryPackage(operation_id);
        return { ok: true, operation: pkg };
      })
  );

  server.registerTool(
    "describe_sequence",
    {
      title: "Describe sequence",
      description:
        "A sequence's saved package plus the STEP chain its read Cypher traverses, so you can " +
        "see which steps run in what order.",
      inputSchema: {
        sequence_id: z.string().describe("Catalog id of the sequence."),
        ...spaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sequence_id, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const pkg = await connector.fetchQueryPackage(sequence_id);
        const entryLabel = parseSequenceEntryLabel(pkg.cypher);
        const chain = entryLabel ? await walkStepChain(spaceId, entryLabel) : [];
        return { ok: true, sequence: pkg, entry_step: entryLabel || null, chain };
      })
  );

  server.registerTool(
    "list_step_nodes",
    {
      title: "List STEP nodes",
      description:
        "Every STEP node in the space's graph with its attributive_label, the operation it wraps " +
        "(sequencial_properties.query_id), and its outgoing POINTS_TO edges.",
      inputSchema: spaceArg,
      annotations: { readOnlyHint: true },
    },
    async ({ space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const nodes = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "STEP" });
        const withEdges = await Promise.all(
          nodes.map(async (node) => ({
            id: node.id,
            attributive_label: node.attributive_label,
            wraps_operation_id: node.sequencial_properties?.query_id ?? null,
            step_type: node.sequencial_properties?.step_type ?? null,
            endpoint: node.sequencial_properties?.endpoint ?? null,
            outgoing: await connector.fetchGraphStepOutgoing({
              spaceId,
              attributiveLabel: node.attributive_label,
            }),
          }))
        );
        return { ok: true, space_id: spaceId, steps: withEdges };
      })
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List SCHEMAs",
      description:
        "Every SCHEMA node in the space's graph. A SCHEMA defines the property contract an " +
        "INSTANCE must satisfy; use describe_schema before creating instances.",
      inputSchema: spaceArg,
      annotations: { readOnlyHint: true },
    },
    async ({ space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const nodes = await connector.fetchGraphNodesByLabel({ spaceId, nodeLabel: "SCHEMA" });
        return {
          ok: true,
          space_id: spaceId,
          schemas: nodes.map((n) => ({ id: n.id, attributive_label: n.attributive_label })),
        };
      })
  );

  server.registerTool(
    "describe_schema",
    {
      title: "Describe SCHEMA",
      description:
        "A SCHEMA's property constraints (key, value_type, is_required, is_key, is_label, format, " +
        "default) and its outgoing edges to other SCHEMAs.",
      inputSchema: {
        attributive_label: z.string().describe("The SCHEMA's attributive_label."),
        ...spaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ attributive_label, space_id }) =>
      guard(async () => {
        const spaceId = resolveSpaceId(config, space_id);
        const [definition, outgoing] = await Promise.all([
          connector.fetchSchemaDefinition({ spaceId, attributiveLabel: attributive_label }),
          connector.fetchSchemaOutgoing({ spaceId, attributiveLabel: attributive_label }),
        ]);
        return { ok: true, definition, outgoing };
      })
  );
}

// A sequence read query matches its initial STEP node by attributive_label, e.g.
//   MATCH (alias:STEP { attributive_label: 'STEP_LABEL' }) RETURN *
const STEP_ATTR_LABEL_RE = /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/i;

function parseSequenceEntryLabel(cypher: string[] | undefined): string {
  for (const statement of cypher || []) {
    const match = STEP_ATTR_LABEL_RE.exec(String(statement ?? ""));
    if (match) return match[1].trim();
  }
  return "";
}

/** Follow POINTS_TO from the entry step, stopping at the first repeat so a cycle terminates. */
async function walkStepChain(
  spaceId: string,
  entryLabel: string
): Promise<Array<{ from: string; to: string; condition?: string; condition_type?: string }>> {
  const chain: Array<{
    from: string;
    to: string;
    condition?: string;
    condition_type?: string;
  }> = [];
  const visited = new Set<string>();
  const queue = [entryLabel];
  while (queue.length) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const edges = await connector.fetchGraphStepOutgoing({
      spaceId,
      attributiveLabel: current,
    });
    for (const edge of edges) {
      chain.push({
        from: current,
        to: edge.target_attributive_label,
        condition: edge.condition,
        condition_type: edge.condition_type,
      });
      if (!visited.has(edge.target_attributive_label)) {
        queue.push(edge.target_attributive_label);
      }
    }
  }
  return chain;
}
