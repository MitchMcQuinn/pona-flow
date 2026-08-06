/** Catalog queries and id generation endpoints. */

import { joinApiPath } from "./api-path.js";
import type { QueryPackageRow, SavedQueryRow } from "./types.js";

function fallbackGenerateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Fetch a server-minted entity id; throws when the bridge is unavailable. */
export async function fetchGeneratedId(apiBase = ""): Promise<string> {
  const res = await fetch(joinApiPath("/api/generate-id", apiBase), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} generating id`);
  const data = await res.json();
  if (!data || typeof data.id !== "string" || !data.id.trim()) {
    throw new Error("Invalid /api/generate-id response");
  }
  return data.id.trim();
}

export async function generateQueryId(apiBase = ""): Promise<string> {
  try {
    return await fetchGeneratedId(apiBase);
  } catch (err) {
    console.warn("generateQueryId: bridge unavailable, using client fallback", err);
    return fallbackGenerateId();
  }
}

export async function fetchSavedQueries(apiBase = ""): Promise<SavedQueryRow[]> {
  const res = await fetch(joinApiPath("/api/queries", apiBase), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading queries`);
  const data = await res.json();
  if (!data || !Array.isArray(data.queries)) throw new Error("Invalid /api/queries response");
  return data.queries;
}

/** Load one catalog query's full package (cypher/sqlite/parameters + builder_config). */
export async function fetchQueryPackage(id: string, apiBase = ""): Promise<QueryPackageRow> {
  const qid = (id || "").trim();
  if (!qid) throw new Error("query id is required");
  const res = await fetch(joinApiPath(`/api/queries/${encodeURIComponent(qid)}`, apiBase), {
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading query package`);
  const data = await res.json();
  if (!data || typeof data.id !== "string") throw new Error("Invalid query package response");
  return data as QueryPackageRow;
}
