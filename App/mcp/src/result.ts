/**
 * Tool result helpers.
 *
 * Every tool returns JSON as text content: agents read these results as data, and a
 * predictable envelope (`ok` plus either a payload or an `error`) lets a model recover
 * from a failed call without the transport surfacing an exception.
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(message: string, details?: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, details }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Run a tool body, converting thrown errors into a readable error result.
 *
 * Authoring failures are routine (a name collision, a validation warning, a missing
 * SCHEMA) and the agent is expected to read the message and try again, so they must come
 * back as content rather than as a protocol-level fault.
 */
export async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
