/** SCHEMA definition and outgoing-edge endpoints. */

import { requestJson } from "./http.js";
import type {
  SchemaAffectedOperation,
  SchemaDefinition,
  SchemaOutgoingEdge,
  SchemaPropertyConstraint,
  SchemaUpdatePreview,
  SchemaUpdateResult,
} from "./types.js";

export async function fetchSchemaDefinition(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<SchemaDefinition> {
  return requestJson<SchemaDefinition>("/api/schema/definition", {
    query: { space_id: opts.spaceId, attributive_label: opts.attributiveLabel },
    apiBase,
    errorLabel: "loading schema definition",
  });
}

export async function fetchSchemaOutgoing(
  opts: { spaceId: string; attributiveLabel: string; includeIncoming?: boolean },
  apiBase?: string
): Promise<SchemaOutgoingEdge[]> {
  const data = await requestJson<{ edges?: SchemaOutgoingEdge[] }>("/api/schema/outgoing", {
    query: {
      space_id: opts.spaceId,
      attributive_label: opts.attributiveLabel,
      include_incoming: opts.includeIncoming ? "true" : undefined,
    },
    apiBase,
    errorLabel: "loading schema outgoing edges",
  });
  return Array.isArray(data.edges) ? data.edges : [];
}

/**
 * Apply an add/delete-only SCHEMA update. The server validates that retained properties are
 * unchanged and that new required properties have a default, then rewrites the schema payload
 * and returns the applied diff for client-side reconciliation.
 */
export async function updateSchemaDefinition(
  opts: {
    spaceId: string;
    schemaId: string;
    attributiveLabel: string;
    schemata: SchemaPropertyConstraint[];
  },
  apiBase?: string
): Promise<SchemaUpdateResult> {
  return requestJson<SchemaUpdateResult>("/api/schema/update", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      schema_id: opts.schemaId,
      attributive_label: opts.attributiveLabel,
      schemata: opts.schemata,
    },
    apiBase,
    errorLabel: "updating schema",
  });
}

/**
 * Dry-run an add/delete-only SCHEMA update. Validates the diff and reports which sequences
 * would be suspended (their INSTANCE step would no longer match the new pattern) WITHOUT
 * persisting anything, so the caller can confirm or abort first.
 */
export async function previewSchemaUpdate(
  opts: {
    spaceId: string;
    schemaId: string;
    attributiveLabel: string;
    schemata: SchemaPropertyConstraint[];
  },
  apiBase?: string
): Promise<SchemaUpdatePreview> {
  return requestJson<SchemaUpdatePreview>("/api/schema/update/preview", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      schema_id: opts.schemaId,
      attributive_label: opts.attributiveLabel,
      schemata: opts.schemata,
    },
    apiBase,
    errorLabel: "previewing schema update",
  });
}

/** List create-INSTANCE operations in the catalog that target a SCHEMA (reverse index). */
export async function fetchSchemaAffectedOperations(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<SchemaAffectedOperation[]> {
  const data = await requestJson<{ operations?: SchemaAffectedOperation[] }>(
    "/api/schema/affected-operations",
    {
      query: { space_id: opts.spaceId, attributive_label: opts.attributiveLabel },
      apiBase,
      errorLabel: "loading affected operations",
    }
  );
  return Array.isArray(data.operations) ? data.operations : [];
}
