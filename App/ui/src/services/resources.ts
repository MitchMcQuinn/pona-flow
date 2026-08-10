/**
 * Code resources API client — scripts behind code-execution STEPs.
 *
 * The transport lives in @pona-flow/connector so the MCP authoring server shares one
 * implementation; this module keeps the UI-facing names and the builder's CodeLanguage
 * type. The code text is stored server-side in a gitignored resources folder and mapped
 * by the catalog `resources` table (UID -> path + name/description/language). The builder
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
  return connector.upsertCodeResource(spaceId, input);
}

export async function fetchCodeResource(
  spaceId: string,
  resourceId: string
): Promise<CodeResourceWithCode> {
  return connector.fetchCodeResource(spaceId, resourceId);
}
