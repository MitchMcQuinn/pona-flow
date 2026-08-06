/**
 * Code resources API client — scripts behind code-execution STEPs.
 *
 * The code text is stored server-side in a gitignored resources folder and mapped by
 * the catalog `resources` table (UID -> path + name/description/language). The builder
 * saves code here BEFORE composing the STEP entity, so the entity payload only ever
 * references the resource UID.
 */

import connector from "./connector";
import type { CodeLanguage } from "../state/builder/types";

export interface CodeResourceMetadata {
  id: string;
  space_id: string;
  name: string;
  description: string;
  language: CodeLanguage;
  path: string;
  creation_date: string;
  modified_date: string;
}

export interface CodeResourceWithCode extends CodeResourceMetadata {
  code: string;
}

export interface UpsertCodeResourceInput {
  /** Existing resource UID to update in place; omit to create a new resource. */
  resourceId?: string;
  name: string;
  description?: string;
  language: CodeLanguage;
  code: string;
}

export async function upsertCodeResource(
  spaceId: string,
  input: UpsertCodeResourceInput
): Promise<CodeResourceMetadata> {
  const res = await fetch(
    connector.joinApiPath(`/api/spaces/${encodeURIComponent(spaceId)}/resources`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_id: input.resourceId ?? "",
        name: input.name,
        description: input.description ?? "",
        language: input.language,
        code: input.code
      })
    }
  );
  const data = (await res.json().catch(() => ({}))) as
    | (CodeResourceMetadata & { error?: string })
    | { error?: string };
  if (!res.ok) {
    throw new Error(
      ("error" in data && data.error) || `resource save failed (${res.status})`
    );
  }
  return data as CodeResourceMetadata;
}

export async function fetchCodeResource(
  spaceId: string,
  resourceId: string
): Promise<CodeResourceWithCode> {
  const res = await fetch(
    connector.joinApiPath(
      `/api/spaces/${encodeURIComponent(spaceId)}/resources/${encodeURIComponent(resourceId)}`
    ),
    { cache: "no-store" }
  );
  const data = (await res.json().catch(() => ({}))) as
    | (CodeResourceWithCode & { error?: string })
    | { error?: string };
  if (!res.ok) {
    throw new Error(
      ("error" in data && data.error) || `resource load failed (${res.status})`
    );
  }
  return data as CodeResourceWithCode;
}
