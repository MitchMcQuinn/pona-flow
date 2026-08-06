/** Package execution endpoint. */

import { joinApiPath } from "./api-path.js";
import type { ExecuteCreateBody } from "./types.js";

export async function executeCreatePackage(
  body: ExecuteCreateBody,
  apiBase = ""
): Promise<Record<string, unknown>> {
  const res = await fetch(joinApiPath("/api/execute-create", apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} executing create`);
  }
  return data;
}
