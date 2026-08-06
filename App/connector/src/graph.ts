/** Neo4j graph validation and picker endpoints. */

import { joinApiPath } from "./api-path.js";
import type { GraphNodeRow, GraphRelationshipRow, StepOutgoingEdge } from "./types.js";

export async function checkAttributiveLabelExists(
  opts: { spaceId: string; attributiveLabel: string; nodeLabel?: string; excludeId?: string },
  apiBase = ""
): Promise<boolean> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    attributive_label: opts.attributiveLabel,
  });
  if (opts.nodeLabel) q.set("node_label", opts.nodeLabel);
  if (opts.excludeId) q.set("exclude_id", opts.excludeId);
  const res = await fetch(
    `${joinApiPath("/api/graph/attributive-label-exists", apiBase)}?${q}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} checking attributive_label`);
  }
  return !!data.exists;
}

export async function checkGraphIdExists(
  opts: { spaceId: string; id: string },
  apiBase = ""
): Promise<boolean> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    id: opts.id,
  });
  const res = await fetch(`${joinApiPath("/api/graph/id-exists", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} checking id`);
  }
  return !!data.exists;
}

export async function checkInstancePropertyExists(
  opts: {
    spaceId: string;
    attributiveLabel: string;
    propertyKey: string;
    value: string;
    excludeId?: string;
  },
  apiBase = ""
): Promise<boolean> {
  const q = new URLSearchParams({
    space_id: opts.spaceId,
    attributive_label: opts.attributiveLabel,
    property_key: opts.propertyKey,
    value: opts.value,
  });
  if (opts.excludeId) q.set("exclude_id", opts.excludeId);
  const res = await fetch(
    `${joinApiPath("/api/graph/instance-property-exists", apiBase)}?${q}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} checking instance property`);
  }
  return !!data.exists;
}

export async function fetchGraphNodesByLabel(
  opts: { spaceId: string; nodeLabel: string; attributiveLabel?: string },
  apiBase = ""
): Promise<GraphNodeRow[]> {
  const spaceId = opts?.spaceId || "";
  const nodeLabel = opts?.nodeLabel || "";
  const q = new URLSearchParams({ space_id: spaceId, node_label: nodeLabel });
  const schemaAl = (opts?.attributiveLabel || "").trim();
  if (schemaAl) q.set("attributive_label", schemaAl);
  const res = await fetch(`${joinApiPath("/api/graph/nodes-by-label", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading graph nodes`);
  }
  return Array.isArray(data.nodes) ? data.nodes : [];
}

export async function fetchGraphRelationshipsByLabel(
  opts: { spaceId: string },
  apiBase = ""
): Promise<GraphRelationshipRow[]> {
  const spaceId = opts?.spaceId || "";
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(
    `${joinApiPath("/api/graph/relationships-by-label", apiBase)}?${q}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading graph relationships`);
  }
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphStepRelationships(
  opts: { spaceId: string },
  apiBase = ""
): Promise<GraphRelationshipRow[]> {
  const spaceId = opts?.spaceId || "";
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(`${joinApiPath("/api/graph/step-relationships", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading STEP relationships`);
  }
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphSchemaRelationships(
  opts: { spaceId: string },
  apiBase = ""
): Promise<GraphRelationshipRow[]> {
  const spaceId = opts?.spaceId || "";
  const q = new URLSearchParams({ space_id: spaceId });
  const res = await fetch(
    `${joinApiPath("/api/graph/schema-relationships", apiBase)}?${q}`,
    { cache: "no-store" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading SCHEMA relationships`);
  }
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphPropertyKeys(
  opts: {
    spaceId: string;
    entityLabel: string;
    attributiveLabel: string;
    entityRole?: "node" | "relationship";
  },
  apiBase = ""
): Promise<string[]> {
  const q = new URLSearchParams({
    space_id: opts?.spaceId || "",
    entity_label: opts?.entityLabel || "",
    entity_role: opts?.entityRole || "node",
    attributive_label: opts?.attributiveLabel || "",
  });
  const res = await fetch(`${joinApiPath("/api/graph/property-keys", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading property keys`);
  }
  return Array.isArray(data.keys) ? data.keys : [];
}

export async function fetchGraphPropertyValues(
  opts: {
    spaceId: string;
    entityLabel: string;
    attributiveLabel: string;
    propertyKey: string;
    entityRole?: "node" | "relationship";
  },
  apiBase = ""
): Promise<string[]> {
  const q = new URLSearchParams({
    space_id: opts?.spaceId || "",
    entity_label: opts?.entityLabel || "",
    entity_role: opts?.entityRole || "node",
    attributive_label: opts?.attributiveLabel || "",
    property_key: opts?.propertyKey || "",
  });
  const res = await fetch(`${joinApiPath("/api/graph/property-values", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading property values`);
  }
  return Array.isArray(data.values) ? data.values : [];
}

export async function fetchGraphStepOutgoing(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase = ""
): Promise<StepOutgoingEdge[]> {
  const spaceId = opts?.spaceId || "";
  const attributiveLabel = opts?.attributiveLabel || "";
  const q = new URLSearchParams({ space_id: spaceId, attributive_label: attributiveLabel });
  const res = await fetch(`${joinApiPath("/api/graph/step-outgoing", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading STEP outgoing edges`);
  }
  return Array.isArray(data.edges) ? data.edges : [];
}

/** Entity id for the STEP node that wraps a saved operation (payload.query_id), if any. */
export async function fetchStepWrapEntityId(
  opts: { spaceId: string; operationId: string },
  apiBase = ""
): Promise<string> {
  const q = new URLSearchParams({
    space_id: opts?.spaceId || "",
    operation_id: opts?.operationId || "",
  });
  const res = await fetch(`${joinApiPath("/api/graph/step-wrap-entity-id", apiBase)}?${q}`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} loading step wrap entity id`);
  }
  return String(data.entity_id ?? "").trim();
}
