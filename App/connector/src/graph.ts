/** Neo4j graph validation and picker endpoints. */

import { requestJson } from "./http.js";
import type { GraphNodeRow, GraphRelationshipRow, StepOutgoingEdge } from "./types.js";

export async function checkAttributiveLabelExists(
  opts: { spaceId: string; attributiveLabel: string; nodeLabel?: string; excludeId?: string },
  apiBase?: string
): Promise<boolean> {
  const data = await requestJson<{ exists?: boolean }>(
    "/api/graph/attributive-label-exists",
    {
      query: {
        space_id: opts.spaceId,
        attributive_label: opts.attributiveLabel,
        node_label: opts.nodeLabel,
        exclude_id: opts.excludeId,
      },
      apiBase,
      errorLabel: "checking attributive_label",
    }
  );
  return !!data.exists;
}

export async function checkGraphIdExists(
  opts: { spaceId: string; id: string },
  apiBase?: string
): Promise<boolean> {
  const data = await requestJson<{ exists?: boolean }>("/api/graph/id-exists", {
    query: { space_id: opts.spaceId, id: opts.id },
    apiBase,
    errorLabel: "checking id",
  });
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
  apiBase?: string
): Promise<boolean> {
  const data = await requestJson<{ exists?: boolean }>(
    "/api/graph/instance-property-exists",
    {
      query: {
        space_id: opts.spaceId,
        attributive_label: opts.attributiveLabel,
        property_key: opts.propertyKey,
        value: opts.value,
        exclude_id: opts.excludeId,
      },
      apiBase,
      errorLabel: "checking instance property",
    }
  );
  return !!data.exists;
}

export async function fetchGraphNodesByLabel(
  opts: { spaceId: string; nodeLabel: string; attributiveLabel?: string },
  apiBase?: string
): Promise<GraphNodeRow[]> {
  const data = await requestJson<{ nodes?: GraphNodeRow[] }>("/api/graph/nodes-by-label", {
    query: {
      space_id: opts?.spaceId || "",
      node_label: opts?.nodeLabel || "",
      attributive_label: (opts?.attributiveLabel || "").trim() || undefined,
    },
    apiBase,
    errorLabel: "loading graph nodes",
  });
  return Array.isArray(data.nodes) ? data.nodes : [];
}

export async function fetchGraphRelationshipsByLabel(
  opts: { spaceId: string },
  apiBase?: string
): Promise<GraphRelationshipRow[]> {
  const data = await requestJson<{ relationships?: GraphRelationshipRow[] }>(
    "/api/graph/relationships-by-label",
    {
      query: { space_id: opts?.spaceId || "" },
      apiBase,
      errorLabel: "loading graph relationships",
    }
  );
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphStepRelationships(
  opts: { spaceId: string },
  apiBase?: string
): Promise<GraphRelationshipRow[]> {
  const data = await requestJson<{ relationships?: GraphRelationshipRow[] }>(
    "/api/graph/step-relationships",
    {
      query: { space_id: opts?.spaceId || "" },
      apiBase,
      errorLabel: "loading STEP relationships",
    }
  );
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphSchemaRelationships(
  opts: { spaceId: string },
  apiBase?: string
): Promise<GraphRelationshipRow[]> {
  const data = await requestJson<{ relationships?: GraphRelationshipRow[] }>(
    "/api/graph/schema-relationships",
    {
      query: { space_id: opts?.spaceId || "" },
      apiBase,
      errorLabel: "loading SCHEMA relationships",
    }
  );
  return Array.isArray(data.relationships) ? data.relationships : [];
}

export async function fetchGraphPropertyKeys(
  opts: {
    spaceId: string;
    entityLabel: string;
    attributiveLabel: string;
    entityRole?: "node" | "relationship";
  },
  apiBase?: string
): Promise<string[]> {
  const data = await requestJson<{ keys?: string[] }>("/api/graph/property-keys", {
    query: {
      space_id: opts?.spaceId || "",
      entity_label: opts?.entityLabel || "",
      entity_role: opts?.entityRole || "node",
      attributive_label: opts?.attributiveLabel || "",
    },
    apiBase,
    errorLabel: "loading property keys",
  });
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
  apiBase?: string
): Promise<string[]> {
  const data = await requestJson<{ values?: string[] }>("/api/graph/property-values", {
    query: {
      space_id: opts?.spaceId || "",
      entity_label: opts?.entityLabel || "",
      entity_role: opts?.entityRole || "node",
      attributive_label: opts?.attributiveLabel || "",
      property_key: opts?.propertyKey || "",
    },
    apiBase,
    errorLabel: "loading property values",
  });
  return Array.isArray(data.values) ? data.values : [];
}

export async function fetchGraphStepOutgoing(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<StepOutgoingEdge[]> {
  const data = await requestJson<{ edges?: StepOutgoingEdge[] }>("/api/graph/step-outgoing", {
    query: {
      space_id: opts?.spaceId || "",
      attributive_label: opts?.attributiveLabel || "",
    },
    apiBase,
    errorLabel: "loading STEP outgoing edges",
  });
  return Array.isArray(data.edges) ? data.edges : [];
}

/** Entity id for the STEP node that wraps a saved operation (payload.query_id), if any. */
export async function fetchStepWrapEntityId(
  opts: { spaceId: string; operationId: string },
  apiBase?: string
): Promise<string> {
  const data = await requestJson<{ entity_id?: string }>("/api/graph/step-wrap-entity-id", {
    query: {
      space_id: opts?.spaceId || "",
      operation_id: opts?.operationId || "",
    },
    apiBase,
    errorLabel: "loading step wrap entity id",
  });
  return String(data.entity_id ?? "").trim();
}
