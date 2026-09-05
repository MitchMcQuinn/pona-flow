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
 * create_operation is what brings STEP nodes into being (a catalog query wrap, or
 * materializing a designed HTTP/LLM STEP), which fixes the order: operations, then
 * transitions, then the sequence.
 */
export const INSTRUCTIONS = `pona flow authoring. These tools configure a pona flow space: they create the
SCHEMAs, INSTANCEs, STEP nodes, and sequences that the engine then runs.

Vocabulary:
- SCHEMA: a property contract (which keys exist, their types, which are required or unique).
- INSTANCE: one record satisfying a SCHEMA.
- STEP: an executable unit — a saved query, an HTTP call, or a Local LLM call.
- POINTS_TO: an edge between two STEP nodes; optionally conditional, which is how branching works.
- Sequence: a saved, runnable entry point naming the STEP the run starts at. One-step sequences
  are still sequences (the nav lists them under Single-step).

Build order (this matters — each stage depends on the previous one existing):
1. create_operation for each step.
   For INSTANCE/SCHEMA/read/update/delete: saves a catalog query, auto-wraps a STEP, and (by
   default) a one-step sequence.
   For create STEP (HTTP / Local LLM): materializes that STEP in the graph. A single new STEP
   is published as a one-step sequence by default (add_as_sequence=false for a STEP-only
   building block). A chain of STEPs is materialized only — call create_sequence after the
   transitions exist. It does not save a factory that mints more STEPs.
2. create_step_transition for each edge, referencing STEP nodes by attributive_label.
3. create_sequence, naming the STEP the chain starts at.
Skipping ahead fails: a sequence created before its steps exist matches nothing, and a
transition cannot attach to a STEP node that has not been created yet.

Before writing, read. attributive_labels are UPPER_SNAKE and globally unique across STEP and
SCHEMA *nodes* (and SCHEMA relationship types) in a space, so call describe_space to see
what is taken and describe_schema before creating instances of one. STEP-to-STEP POINTS_TO
edges are the exception: they default to NEXT and that label may be reused on every link.
Writes are validated with the same rules the visual builder uses, and a rejected write
comes back as a readable message — read it and adjust rather than retrying.

Deletion is two-phase. delete_step, delete_schema, and delete_operation refuse to write on
their first call: they return the blast radius and a confirm_token. Show the user what would
be removed before calling again with the token. delete_operation on a sequence unlinks it
from the nav. On a catalog query it deletes the wrap STEP and one-step sequence; multi-step
sequences that MATCH that STEP are suspended, not deleted.

A create-SCHEMA or create-INSTANCE package describes nodes and materializes them only when
it runs. Pass execute=true to create_operation for those. A create-STEP package always
materializes the designed STEP.`;

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
