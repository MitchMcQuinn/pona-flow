/** Catalog queries, saved packages, and id generation endpoints. */

import { requestJson } from "./http.js";
import type { QueriesUpsertPayload, QueryPackageRow, SavedQueryRow } from "./types.js";

function fallbackGenerateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Fetch a server-minted entity id; throws when the bridge is unavailable. */
export async function fetchGeneratedId(apiBase?: string): Promise<string> {
  const data = await requestJson<{ id?: string }>("/api/generate-id", {
    apiBase,
    errorLabel: "generating id",
  });
  if (!data || typeof data.id !== "string" || !data.id.trim()) {
    throw new Error("Invalid /api/generate-id response");
  }
  return data.id.trim();
}

export async function generateQueryId(apiBase?: string): Promise<string> {
  try {
    return await fetchGeneratedId(apiBase);
  } catch (err) {
    console.warn("generateQueryId: bridge unavailable, using client fallback", err);
    return fallbackGenerateId();
  }
}

export async function fetchSavedQueries(apiBase?: string): Promise<SavedQueryRow[]> {
  const data = await requestJson<{ queries?: SavedQueryRow[] }>("/api/queries", {
    apiBase,
    errorLabel: "loading queries",
  });
  if (!data || !Array.isArray(data.queries)) throw new Error("Invalid /api/queries response");
  return data.queries;
}

/** Load one catalog query's full package (cypher/sqlite/parameters + builder_config). */
export async function fetchQueryPackage(id: string, apiBase?: string): Promise<QueryPackageRow> {
  const qid = (id || "").trim();
  if (!qid) throw new Error("query id is required");
  const data = await requestJson<QueryPackageRow>(
    `/api/queries/${encodeURIComponent(qid)}`,
    { apiBase, errorLabel: "loading query package" }
  );
  if (!data || typeof data.id !== "string") throw new Error("Invalid query package response");
  return data;
}

export interface SequenceParameterPreview {
  parameters: Array<Record<string, unknown>>;
  parameter_values: Record<string, unknown>;
}

/**
 * Bindable STEP inputs for a saved sequence or an unsaved entry STEP, plus any
 * values already baked into the sequence catalog.
 */
export async function previewSequenceParameters(
  opts: {
    spaceId: string;
    sequenceId?: string;
    entryStep?: string;
    traversal?: "single" | "downstream";
  },
  apiBase?: string
): Promise<SequenceParameterPreview> {
  const data = await requestJson<SequenceParameterPreview>("/api/sequence/preview-parameters", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      sequence_id: opts.sequenceId,
      entry_step: opts.entryStep,
      traversal: opts.traversal,
    },
    apiBase,
    errorLabel: "previewing sequence parameters",
  });
  return {
    parameters: Array.isArray(data.parameters) ? data.parameters : [],
    parameter_values:
      data.parameter_values && typeof data.parameter_values === "object" && !Array.isArray(data.parameter_values)
        ? data.parameter_values
        : {},
  };
}

/**
 * Insert or replace a catalog queries row (operation or sequence). The composed
 * cypher/sqlite/parameters and the declarative builder_config snapshot all travel
 * together so a saved package can be round-tripped back into the visual builder.
 */
export async function upsertQuery(
  payload: QueriesUpsertPayload,
  apiBase?: string
): Promise<{ id: string }> {
  const data = await requestJson<{ id?: string }>("/api/queries/upsert", {
    method: "POST",
    body: payload,
    apiBase,
    errorLabel: "upserting query",
  });
  return { id: data.id ?? payload.id };
}

/** Edit a saved package's prose description without touching its composed statements. */
export async function updateQueryDescription(
  opts: { spaceId: string; queryId: string; description: string },
  apiBase?: string
): Promise<Record<string, unknown>> {
  const qid = (opts.queryId || "").trim();
  if (!qid) throw new Error("query id is required");
  return requestJson(`/api/queries/${encodeURIComponent(qid)}/description`, {
    method: "POST",
    body: { space_id: opts.spaceId, description: opts.description },
    apiBase,
    errorLabel: "updating query description",
  });
}

/**
 * Remove a sequence's catalog row (and its composed state packages) while leaving the
 * underlying STEP nodes intact. The cascading variant is `executeStepDeletion`.
 */
export async function deleteSequenceDefinition(
  opts: { spaceId: string; sequenceId: string },
  apiBase?: string
): Promise<Record<string, unknown>> {
  return requestJson("/api/sequence/delete", {
    method: "POST",
    body: { space_id: opts.spaceId, id: opts.sequenceId },
    apiBase,
    errorLabel: "deleting sequence",
  });
}
