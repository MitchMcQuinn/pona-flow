/**
 * Dev-server API client for the React QUERY builder and the MCP authoring server.
 *
 * Browser callers get their Clerk token from the UI's global fetch wrapper; Node callers
 * register a fetch implementation, API base, and agent-key headers via `configure()`.
 * Run: python Engine/dev_server.py — then open /App/ui/dist/index.html
 */

import { joinApiPath } from "./api-path.js";
import {
  executeSchemaDeletion,
  executeStepDeletion,
  previewSchemaDeletion,
  previewStepDeletion,
} from "./deletes.js";
import { executeCreatePackage, executeQueryPackage } from "./execute.js";
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
import { configure, configuredApiBase, resetConfig } from "./http.js";
import {
  deleteSequenceDefinition,
  fetchQueryPackage,
  fetchSavedQueries,
  generateQueryId,
  updateQueryDescription,
  upsertQuery,
} from "./queries.js";
import { fetchCodeResource, upsertCodeResource } from "./resources.js";
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
import type {
  CodeResourceMetadata,
  CodeResourceWithCode,
  ExecuteCreateBody,
  ExecuteQueryBody,
  ExecuteQueryResponse,
  QueriesUpsertPayload,
  SavedQueryRow,
  SchemaDeletePreview,
  SchemaDeleteResult,
  SpaceConnections,
  SpaceRow,
  StepDeletePreview,
  StepDeleteResult,
  UpsertCodeResourceInput,
} from "./types.js";

// Single implementations shared with the UI's services/api.ts (adapter-level dedupe).
export { fetchGeneratedId } from "./queries.js";
export { fetchSpaceGroups } from "./spaces.js";
export { configure, configuredApiBase, resetConfig } from "./http.js";
export type { ConnectorConfig } from "./http.js";

export type {
  AffectedSequence,
  CodeResourceLanguage,
  CodeResourceMetadata,
  CodeResourceWithCode,
  CypherStatementResult,
  DeleteSpaceRef,
  DeleteWarning,
  ExecuteCreateBody,
  ExecuteQueryBody,
  ExecuteQueryResponse,
  GraphNodeRow,
  GraphRelationshipRow,
  QueriesUpsertPayload,
  QueryPackageRow,
  SavedQueryRow,
  SchemaAffectedOperation,
  SchemaDefinition,
  SchemaDeletePreview,
  SchemaDeleteResult,
  SchemaOutgoingEdge,
  SchemaPropertyConstraint,
  SchemaUpdatePreview,
  SchemaUpdateResult,
  SpaceConnections,
  StepDeletePreview,
  StepDeleteResult,
  StepOutgoingEdge,
  SuspensionChange,
  UpsertCodeResourceInput,
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
  upsertQuery(payload: QueriesUpsertPayload, apiBase?: string): Promise<{ id: string }>;
  updateQueryDescription(
    opts: { spaceId: string; queryId: string; description: string },
    apiBase?: string
  ): Promise<Record<string, unknown>>;
  deleteSequenceDefinition(
    opts: { spaceId: string; sequenceId: string },
    apiBase?: string
  ): Promise<Record<string, unknown>>;
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
  executeQueryPackage(body: ExecuteQueryBody, apiBase?: string): Promise<ExecuteQueryResponse>;
  upsertCodeResource(
    spaceId: string,
    input: UpsertCodeResourceInput,
    apiBase?: string
  ): Promise<CodeResourceMetadata>;
  fetchCodeResource(
    spaceId: string,
    resourceId: string,
    apiBase?: string
  ): Promise<CodeResourceWithCode>;
  previewSchemaDeletion(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<SchemaDeletePreview>;
  executeSchemaDeletion(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<SchemaDeleteResult>;
  previewStepDeletion(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<StepDeletePreview>;
  executeStepDeletion(
    opts: { spaceId: string; attributiveLabel: string },
    apiBase?: string
  ): Promise<StepDeleteResult>;
  configure(cfg: import("./http.js").ConnectorConfig): void;
  configuredApiBase(): string;
  resetConfig(): void;
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
  upsertQuery,
  updateQueryDescription,
  deleteSequenceDefinition,
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
  executeQueryPackage,
  upsertCodeResource,
  fetchCodeResource,
  previewSchemaDeletion,
  executeSchemaDeletion,
  previewStepDeletion,
  executeStepDeletion,
  configure,
  configuredApiBase,
  resetConfig,
};

export default connector;
