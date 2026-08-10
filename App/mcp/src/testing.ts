/**
 * In-process harness for the diagnostic scripts under tests/.
 *
 * Those scripts live outside this package, so a bare `@modelcontextprotocol/sdk` import
 * from there would not resolve. Connecting a client to the server over a linked in-memory
 * transport also exercises the real protocol path — schema generation, argument validation,
 * error envelopes — which is where tool-definition mistakes actually show up.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./index.js";
import type { McpConfig } from "./config.js";

export interface ConnectedServer {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

export async function connectTestClient(config: McpConfig): Promise<ConnectedServer> {
  const server = createServer(config);
  const client = new Client({ name: "pona-flow-authoring-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
