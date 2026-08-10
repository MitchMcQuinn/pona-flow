/**
 * Environment-derived configuration, and the one place the connector is pointed at a host.
 *
 * The connector calls bare `fetch` and, in the browser, picks up the Clerk token from the
 * UI's global fetch wrapper. There is no `window` here, so this module registers an
 * explicit fetch implementation, API base, and header provider instead.
 *
 * For local `npm start`, we also load the engine root `.env` (the same file the Python
 * server reads). Cursor's mcp.json `env` block still wins when it sets a variable —
 * file values only fill gaps.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connector } from "@pona-flow/connector";

export interface McpConfig {
  apiBase: string;
  spaceId: string;
  agentKey: string;
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Parse KEY=VALUE lines into process.env without overriding anything already set
 * (shell / mcp.json take precedence over the file).
 */
function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Engine root is two levels above App/mcp/src (…/pona-flow/App/mcp/src → …/pona-flow). */
function loadEngineEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../.env"), // App/mcp/src → pona-flow/.env
    resolve(process.cwd(), "../../.env"), // npm start from App/mcp
    resolve(process.cwd(), ".env"), // cwd is already the engine root
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      applyEnvFile(path);
      return;
    }
  }
}

export function loadConfig(): McpConfig {
  loadEngineEnv();

  const apiBase = (process.env.PONA_FLOW_API_BASE || "http://127.0.0.1:8765").replace(/\/$/, "");
  const spaceId = (process.env.PONA_FLOW_SPACE_ID || "").trim();
  const agentKey = (process.env.PONA_FLOW_KEY || "").trim();

  if (!agentKey && !envFlag("PONA_FLOW_DISABLE_AUTH")) {
    throw new Error(
      "PONA_FLOW_KEY is required unless PONA_FLOW_DISABLE_AUTH=1 (local development). " +
        "Set them in pona-flow/.env, in the shell, or in Cursor mcp.json env."
    );
  }
  return { apiBase, spaceId, agentKey };
}

/** Point @pona-flow/connector at this host so the authoring package can reach the API. */
export function configureConnector(config: McpConfig): void {
  connector.configure({
    apiBase: config.apiBase,
    fetch: globalThis.fetch,
    headers: (): Record<string, string> =>
      config.agentKey ? { "X-Pona-Flow-Key": config.agentKey } : {},
  });
}

/**
 * The space a tool call targets. Tools accept an explicit `space_id` so one server can
 * serve several spaces; PONA_FLOW_SPACE_ID supplies the default for single-space setups.
 */
export function resolveSpaceId(config: McpConfig, provided?: string): string {
  const spaceId = (provided || "").trim() || config.spaceId;
  if (!spaceId) {
    throw new Error(
      "No space selected. Pass space_id, or set PONA_FLOW_SPACE_ID to a default. " +
        "Call list_spaces to see the available ids."
    );
  }
  return spaceId;
}
