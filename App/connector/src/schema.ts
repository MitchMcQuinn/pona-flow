/** SCHEMA definition and outgoing-edge endpoints. */

import { joinApiPath } from "./api-path.js";
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
  apiBase = ""
): Promise<SchemaDefinition> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    attributive_label: opts.attributiveLabel,
  });
  const res = await fetch(`${joinApiPath("/api/schema/definition", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading schema definition`);
  }
  return data;
}

export async function fetchSchemaOutgoing(
  opts: { spaceId: string; attributiveLabel: string; includeIncoming?: boolean },
  apiBase = ""
): Promise<SchemaOutgoingEdge[]> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    attributive_label: opts.attributiveLabel,
  });
  if (opts.includeIncoming) q.set("include_incoming", "true");
  const res = await fetch(`${joinApiPath("/api/schema/outgoing", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading schema outgoing edges`);
  }
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
  apiBase = ""
): Promise<SchemaUpdateResult> {
  const res = await fetch(joinApiPath("/api/schema/update", apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: opts.spaceId,
      schema_id: opts.schemaId,
      attributive_label: opts.attributiveLabel,
      schemata: opts.schemata,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} updating schema`);
  }
  return data as SchemaUpdateResult;
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
  apiBase = ""
): Promise<SchemaUpdatePreview> {
  const res = await fetch(joinApiPath("/api/schema/update/preview", apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      space_id: opts.spaceId,
      schema_id: opts.schemaId,
      attributive_label: opts.attributiveLabel,
      schemata: opts.schemata,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} previewing schema update`);
  }
  return data as SchemaUpdatePreview;
}

/** List create-INSTANCE operations in the catalog that target a SCHEMA (reverse index). */
export async function fetchSchemaAffectedOperations(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase = ""
): Promise<SchemaAffectedOperation[]> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    attributive_label: opts.attributiveLabel,
  });
  const res = await fetch(
    `${joinApiPath("/api/schema/affected-operations", apiBase)}?${q}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading affected operations`);
  }
  return Array.isArray(data.operations) ? data.operations : [];
}
