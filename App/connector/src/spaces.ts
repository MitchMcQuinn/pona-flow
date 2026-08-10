/** Space catalog and per-space metadata endpoints. */

import { requestJson } from "./http.js";
import type { SpaceConnections, SpaceRow } from "./types.js";

export async function fetchSpaces(apiBase?: string): Promise<{
  catalogSqliteEnvKey: string;
  spaces: SpaceRow[];
}> {
  const data = await requestJson<{ catalog_sqlite_env_key?: string; spaces?: SpaceRow[] }>(
    "/api/spaces",
    { apiBase, errorLabel: "loading spaces" }
  );
  if (!data || !Array.isArray(data.spaces)) throw new Error("Invalid /api/spaces response");
  return {
    catalogSqliteEnvKey: data.catalog_sqlite_env_key || "",
    spaces: data.spaces,
  };
}

export async function fetchSpaceConnections(
  spaceId: string,
  apiBase?: string
): Promise<SpaceConnections> {
  const data = await requestJson<SpaceConnections>("/api/space/connections", {
    query: { space_id: spaceId },
    apiBase,
    errorLabel: "loading space connections",
  });
  if (!data || data.space_id !== spaceId) {
    throw new Error("Invalid /api/space/connections response");
  }
  return data;
}

export async function fetchSpaceLabels(spaceId: string, apiBase?: string): Promise<string[]> {
  const data = await requestJson<{ labels?: string[] }>("/api/space/labels", {
    query: { space_id: spaceId },
    apiBase,
    errorLabel: "loading space labels",
  });
  return Array.isArray(data.labels) ? data.labels : [];
}

export async function fetchSpaceGroups(spaceId: string, apiBase?: string): Promise<string[]> {
  const data = await requestJson<{ groups?: string[] }>("/api/space/groups", {
    query: { space_id: spaceId },
    apiBase,
    errorLabel: "loading space groups",
  });
  return Array.isArray(data.groups) ? data.groups : [];
}
