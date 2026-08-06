/** Space catalog and per-space metadata endpoints. */

import { joinApiPath } from "./api-path.js";
import type { SpaceConnections, SpaceRow } from "./types.js";

export async function fetchSpaces(apiBase = ""): Promise<{
  catalogSqliteEnvKey: string;
  spaces: SpaceRow[];
}> {
  const res = await fetch(joinApiPath("/api/spaces", apiBase), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading spaces`);
  const data = await res.json();
  if (!data || !Array.isArray(data.spaces)) throw new Error("Invalid /api/spaces response");
  return {
    catalogSqliteEnvKey: data.catalog_sqlite_env_key || "",
    spaces: data.spaces,
  };
}

export async function fetchSpaceConnections(
  spaceId: string,
  apiBase = ""
): Promise<SpaceConnections> {
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(`${joinApiPath("/api/space/connections", apiBase)}?${q}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading space connections`);
  const data = await res.json();
  if (!data || data.space_id !== spaceId) throw new Error("Invalid /api/space/connections response");
  return data;
}

export async function fetchSpaceLabels(spaceId: string, apiBase = ""): Promise<string[]> {
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(`${joinApiPath("/api/space/labels", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading space labels`);
  }
  return Array.isArray(data.labels) ? data.labels : [];
}

export async function fetchSpaceGroups(spaceId: string, apiBase = ""): Promise<string[]> {
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(`${joinApiPath("/api/space/groups", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading space groups`);
  }
  return Array.isArray(data.groups) ? data.groups : [];
}
