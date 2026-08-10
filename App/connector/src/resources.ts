/**
 * Code resources API client — scripts behind code-execution STEPs.
 *
 * The code text is stored server-side in a gitignored resources folder and mapped by the
 * catalog `resources` table (UID -> path + name/description/language). Authoring saves the
 * code here BEFORE composing the STEP entity, so the entity payload only ever references
 * the resource UID.
 */

import { requestJson } from "./http.js";
import type {
  CodeResourceMetadata,
  CodeResourceWithCode,
  UpsertCodeResourceInput,
} from "./types.js";

export async function upsertCodeResource(
  spaceId: string,
  input: UpsertCodeResourceInput,
  apiBase?: string
): Promise<CodeResourceMetadata> {
  return requestJson<CodeResourceMetadata>(
    `/api/spaces/${encodeURIComponent(spaceId)}/resources`,
    {
      method: "PUT",
      body: {
        resource_id: input.resourceId ?? "",
        name: input.name,
        description: input.description ?? "",
        language: input.language,
        code: input.code,
      },
      apiBase,
      errorLabel: "saving resource",
    }
  );
}

export async function fetchCodeResource(
  spaceId: string,
  resourceId: string,
  apiBase?: string
): Promise<CodeResourceWithCode> {
  return requestJson<CodeResourceWithCode>(
    `/api/spaces/${encodeURIComponent(spaceId)}/resources/${encodeURIComponent(resourceId)}`,
    { apiBase, errorLabel: "loading resource" }
  );
}
