#!/usr/bin/env -S npx tsx
/**
 * stdio entry point. Cursor launches this process and speaks MCP over its stdin/stdout,
 * which is why nothing here may write to stdout — diagnostics go to stderr or they corrupt
 * the protocol stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServerFromEnv } from "./index.js";

async function main(): Promise<void> {
  const { server, config } = createServerFromEnv();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `pona-flow authoring MCP ready (api=${config.apiBase}, space=${config.spaceId || "unset"})\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pona-flow authoring MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
