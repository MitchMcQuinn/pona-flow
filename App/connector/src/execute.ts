/** Package execution endpoints. */

import { requestJson } from "./http.js";
import type {
  ExecuteCreateBody,
  ExecuteQueryBody,
  ExecuteQueryResponse,
} from "./types.js";

export async function executeCreatePackage(
  body: ExecuteCreateBody,
  apiBase?: string
): Promise<Record<string, unknown>> {
  return requestJson("/api/execute-create", {
    method: "POST",
    body,
    apiBase,
    errorLabel: "executing create",
  });
}

/** Run a composed read/update/delete package (graph Cypher + entity SQLite). */
export async function executeQueryPackage(
  body: ExecuteQueryBody,
  apiBase?: string
): Promise<ExecuteQueryResponse> {
  return requestJson<ExecuteQueryResponse>("/api/execute-query", {
    method: "POST",
    body,
    apiBase,
    errorLabel: "executing query",
  });
}
