/**
 * Dev-server API client for the React QUERY builder (spaces, graph checks, execute).
 * Run: python Engine/dev_server.py — then open /App/ui/dist/index.html
 */

import { joinApiPath } from "./api-path.js";
import { executeCreatePackage } from "./execute.js";
import {
  checkAttributiveLabelExists,
  checkGraphIdExists,
  checkInstancePropertyExists,
  fetchGraphNodesByLabel,
  fetchGraphPropertyKeys,
  fetchGraphPropertyValues,
  fetchGraphRelationshipsByLabel,
  fetchGraphSchemaRelationships,
  fetchGraphStepOutgoing,
  fetchGraphStepRelationships,
  fetchStepWrapEntityId,
} from "./graph.js";
import { fetchQueryPackage, fetchSavedQueries, generateQueryId } from "./queries.js";
import {
  fetchSchemaAffectedOperations,
  fetchSchemaDefinition,
  fetchSchemaOutgoing,
  previewSchemaUpdate,
  updateSchemaDefinition,
} from "./schema.js";
import {
  fetchSpaceConnections,
  fetchSpaceGroups,
  fetchSpaceLabels,
  fetchSpaces,
} from "./spaces.js";
import type { ExecuteCreateBody, SavedQueryRow, SpaceConnections, SpaceRow } from "./types.js";

// Single implementations shared with the UI's services/api.ts (adapter-level dedupe).
export { fetchGeneratedId } from "./queries.js";
export { fetchSpaceGroups } from "./spaces.js";

export type {
  AffectedSequence,
  ExecuteCreateBody,
  GraphNodeRow,
  GraphRelationshipRow,
  QueryPackageRow,
  SavedQueryRow,
  SchemaAffectedOperation,
  SchemaDefinition,
  SchemaOutgoingEdge,
  SchemaPropertyConstraint,
  SchemaUpdatePreview,
  SchemaUpdateResult,
  SpaceConnections,
  StepOutgoingEdge,
  SuspensionChange,
} from "./types.js";

export interface ConnectorApi {
  joinApiPath(path: string, apiBase?: string): string;
  fetchSpaces(apiBase?: string): Promise<{ catalogSqliteEnvKey: string; spaces: SpaceRow[] }>;
  fetchSpaceConnections(spaceId: string, apiBase?: string): Promise<SpaceConnections>;
  fetchSpaceLabels(spaceId: string, apiBase?: string): Promise<string[]>;
  fetchSpaceGroups(spaceId: string, apiBase?: string): Promise<string[]>;
  fetchSchemaDefinition(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<import("./types.js").SchemaDefinition>;
  fetchSchemaOutgoing(
    opts: { spaceId: string; attributiveLabel: string; includeIncoming?: boolean },
    apiBase?: string
  ): Promise<import("./types.js").SchemaOutgoingEdge[]>;
  updateSchemaDefinition(
    opts: {
      spaceId: string;
      schemaId: string;
      attributiveLabel: string;
      schemata: import("./types.js").SchemaPropertyConstraint[];
    },
    apiBase?: string
  ): Promise<import("./types.js").SchemaUpdateResult>;
  previewSchemaUpdate(
    opts: {
      spaceId: string;
      schemaId: string;
      attributiveLabel: string;
      schemata: import("./types.js").SchemaPropertyConstraint[];
    },
    apiBase?: string
  ): Promise<import("./types.js").SchemaUpdatePreview>;
  fetchSchemaAffectedOperations(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<import("./types.js").SchemaAffectedOperation[]>;
  checkInstancePropertyExists(
    opts: {
      spaceId: string;
      attributiveLabel: string;
      propertyKey: string;
      value: string;
      excludeId?: string;
    },
    apiBase?: string
  ): Promise<boolean>;
  fetchSavedQueries(apiBase?: string): Promise<SavedQueryRow[]>;
  fetchQueryPackage(id: string, apiBase?: string): Promise<import("./types.js").QueryPackageRow>;
  generateQueryId(apiBase?: string): Promise<string>;
  checkAttributiveLabelExists(
    opts: { spaceId: string; attributiveLabel: string; nodeLabel?: string; excludeId?: string },
    apiBase?: string
  ): Promise<boolean>;
  checkGraphIdExists(opts: { spaceId: string; id: string }, apiBase?: string): Promise<boolean>;
  fetchGraphNodesByLabel(
    opts: { spaceId: string; nodeLabel: string; attributiveLabel?: string },
    apiBase?: string
  ): Promise<import("./types.js").GraphNodeRow[]>;
  fetchGraphRelationshipsByLabel(
    opts: { spaceId: string },
    apiBase?: string
  ): Promise<import("./types.js").GraphRelationshipRow[]>;
  fetchGraphStepRelationships(
    opts: { spaceId: string },
    apiBase?: string
  ): Promise<import("./types.js").GraphRelationshipRow[]>;
  fetchGraphSchemaRelationships(
    opts: { spaceId: string },
    apiBase?: string
  ): Promise<import("./types.js").GraphRelationshipRow[]>;
  fetchGraphStepOutgoing(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<import("./types.js").StepOutgoingEdge[]>;
  fetchStepWrapEntityId(
    opts: { spaceId: string; operationId: string },
    apiBase?: string
  ): Promise<string>;
  fetchGraphPropertyKeys(
    opts: {
      spaceId: string;
      entityLabel: string;
      attributiveLabel: string;
      entityRole?: "node" | "relationship";
    },
    apiBase?: string
  ): Promise<string[]>;
  fetchGraphPropertyValues(
    opts: {
      spaceId: string;
      entityLabel: string;
      attributiveLabel: string;
      propertyKey: string;
      entityRole?: "node" | "relationship";
    },
    apiBase?: string
  ): Promise<string[]>;
  executeCreatePackage(body: ExecuteCreateBody, apiBase?: string): Promise<Record<string, unknown>>;
}

export const connector: ConnectorApi = {
  joinApiPath,
  fetchSpaces,
  fetchSpaceConnections,
  fetchSpaceLabels,
  fetchSpaceGroups,
  fetchSchemaDefinition,
  fetchSchemaOutgoing,
  updateSchemaDefinition,
  previewSchemaUpdate,
  fetchSchemaAffectedOperations,
  checkInstancePropertyExists,
  fetchSavedQueries,
  fetchQueryPackage,
  generateQueryId,
  checkAttributiveLabelExists,
  checkGraphIdExists,
  fetchGraphNodesByLabel,
  fetchGraphRelationshipsByLabel,
  fetchGraphSchemaRelationships,
  fetchGraphStepRelationships,
  fetchGraphStepOutgoing,
  fetchStepWrapEntityId,
  fetchGraphPropertyKeys,
  fetchGraphPropertyValues,
  executeCreatePackage,
};

export default connector;
