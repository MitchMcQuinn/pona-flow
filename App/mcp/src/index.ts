/**
 * The pona flow authoring MCP server.
 *
 * This is a second, separate MCP surface. The per-space gateway in
 * Engine/server/mcp_gateway.py exposes saved sequences as *runnable* tools; this one
 * exposes the surface that *creates* them. It runs as a Node process rather than inside the
 * Python engine because authoring means composing Cypher, and the composer
 * (@pona-flow/composer) is TypeScript with no Python equivalent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureConnector, loadConfig, type McpConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";

export { loadConfig, configureConnector, resolveSpaceId, type McpConfig } from "./config.js";
export * from "./intent.js";

/**
 * Ordering guidance the agent would otherwise have to discover by failing.
 *
 * A sequence's read Cypher matches STEP nodes by attributive_label at run time, and a
 * transition attaches to STEP nodes by graph id, so both need their nodes to already exist.
 * Operations are what bring STEP nodes into being (each save auto-wraps one), which fixes
 * the order: operations, then transitions, then the sequence.
 */
export const INSTRUCTIONS = `pona flow authoring. These tools configure a pona flow space: they create the
SCHEMAs, INSTANCEs, STEP nodes, and sequences that the engine then runs.

Vocabulary:
- SCHEMA: a property contract (which keys exist, their types, which are required or unique).
- INSTANCE: one record satisfying a SCHEMA.
- STEP: an executable unit — a saved operation, an HTTP call, or a code script.
- POINTS_TO: an edge between two STEP nodes; optionally conditional, which is how branching works.
- Sequence: a saved, runnable entry point naming the STEP the run starts at.

Build order (this matters — each stage depends on the previous one existing):
1. create_operation for each step. Every saved operation is auto-wrapped in a STEP node.
2. create_step_transition for each edge, referencing STEP nodes by attributive_label.
3. create_sequence, naming the STEP the chain starts at.
Skipping ahead fails: a sequence created before its steps exist matches nothing, and a
transition cannot attach to a STEP node that has not been created yet.

Before writing, read. attributive_labels are UPPER_SNAKE and globally unique across STEP and
SCHEMA in a space, so call describe_space to see what is taken and describe_schema before
creating instances of one. Writes are validated with the same rules the visual builder uses,
and a rejected write comes back as a readable message — read it and adjust rather than retrying.

Deletion cascades. delete_step, delete_schema, and delete_operation refuse to write on their
first call: they return the blast radius and a confirm_token. Show the user what would be
removed before calling again with the token.

A create package describes nodes but does not create them until it runs. Pass execute=true to
create_operation when the SCHEMA, INSTANCE, or STEP nodes should exist right away.`;

export function createServer(config: McpConfig): McpServer {
  const server = new McpServer(
    { name: "pona-flow-authoring", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } }
  );
  registerAllTools(server, config);
  return server;
}

/** Load config, point the connector at the API, and build the server. */
export function createServerFromEnv(): { server: McpServer; config: McpConfig } {
  const config = loadConfig();
  configureConnector(config);
  return { server: createServer(config), config };
}
