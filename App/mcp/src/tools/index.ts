import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpConfig } from "../config.js";
import { registerDestructiveTools } from "./destructive.js";
import { registerIntrospectionTools } from "./introspection.js";
import { registerOperationTools } from "./operations.js";
import { registerSequenceTools } from "./sequences.js";

export { registerDestructiveTools } from "./destructive.js";
export { registerIntrospectionTools } from "./introspection.js";
export { registerOperationTools } from "./operations.js";
export { registerSequenceTools } from "./sequences.js";

export function registerAllTools(server: McpServer, config: McpConfig): void {
  registerIntrospectionTools(server, config);
  registerOperationTools(server, config);
  registerSequenceTools(server, config);
  registerDestructiveTools(server, config);
}
