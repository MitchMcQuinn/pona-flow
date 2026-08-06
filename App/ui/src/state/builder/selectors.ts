import composer from "../../services/composer";
import { formatPreviewSqlBlock, formatSqlForPreview } from "../../utils/formatSqlForPreview";
import { collectCreateAttributiveLabels } from "./attributiveLabels";
import {
  isEntityConfigUpdate,
  isLabelOnlyDelete,
  isLabelOnlyMatch,
  isRunnableEndpointStepCreate
} from "./matchMode";
import { queryUsesParameters } from "./parameterRefs";
import { collectDeleteTargetBindings } from "./returnProjections";
import {
  catalogRuntimeEnabled,
  checksAllClear,
  isActiveCheckKey,
  isStepCreateQuery,
  validateQuery
} from "./validation";
import type { BuilderState, ComposedQuery, PathElement, QueryObject } from "./types";

// Relationships built with a cypher condition store the structured builder, but
// the composer reads a precomputed `condition` string. Derive it before composing.
export function normalizeForCompose(query: QueryObject): QueryObject {
  // Read/delete STEP/SCHEMA targets matched entities by attributive_label only: strip any
  // residual per-path WHERE filters so no stray predicate composes. Delete additionally
  // (below) replaces the DELETE clause with a DETACH DELETE of every MATCH variable.
  const labelOnlyMatch = isLabelOnlyMatch(query.operation, query.match[0]?.label);
  const labelOnlyDelete = isLabelOnlyDelete(query.operation, query.match[0]?.label);

  const normalized: QueryObject = {
    ...query,
    match: query.match.map((clause) => ({
      ...clause,
      patterns: clause.patterns.map((pattern) => ({
        ...pattern,
        path: pattern.path.map((element): PathElement => {
          if (element.kind === "relationship") {
            let rel = element.relationship;
            if (rel.condition_type === "cypher" && rel.cypher_condition) {
              rel = {
                ...rel,
                condition: composer.buildExistsInstanceCondition(rel.cypher_condition)
              };
            }
            if (labelOnlyMatch) {
              rel = { ...rel, where: undefined, where_enabled: false };
            }
            return { kind: "relationship", relationship: rel };
          }
          if (labelOnlyMatch && element.kind === "node") {
            return {
              kind: "node",
              node: { ...element.node, where: undefined, where_enabled: false }
            };
          }
          return element;
        })
      }))
    }))
  };

  if (labelOnlyDelete) {
    const targets = collectDeleteTargetBindings(normalized)
      .map((binding) => binding.variable.trim())
      .filter(Boolean);
    normalized.delete = { detach: true, targets };
  }

  return normalized;
}

export interface ComposedPreview {
  composed: ComposedQuery;
  crudJson: string;
  cypher: string;
  sqlite: string;
  /** One block per statement group for spaced rendering in live preview. */
  sqliteBlocks: Array<{ text: string; kind: "queries" | "spaces" | "entities" }>;
}

// Build the CRUD package v2 document the same way the legacy buildCrudPackageDocument did,
// but from typed state instead of the DOM.
export function composePreview(state: BuilderState): ComposedPreview {
  const query = normalizeForCompose(state.query);
  let composed: ComposedQuery;
  try {
    composed = composer.composeQuery(query);
  } catch (error) {
    composed = {
      cypher: `// compose error: ${error instanceof Error ? error.message : String(error)}`,
      sqlite: [],
      parameters: {},
      operation: query.operation
    };
  }

  const entitySqlite = composed.sqlite;
  const { text: previewSqlite, blocks: sqliteBlocks } = buildPreviewSqlite(
    state,
    query,
    composed,
    entitySqlite
  );

  const crudDoc = {
    space_id: state.spaceId ?? "",
    operation: query.operation,
    node_label: primaryNodeLabel(query),
    id: query.id,
    name: query.name,
    cypher: splitCypher(composed.cypher),
    sqlite: entitySqlite,
    parameters: query.parameters
  };

  return {
    composed,
    crudJson: JSON.stringify(crudDoc, null, 2),
    cypher: composed.cypher,
    sqlite: previewSqlite,
    sqliteBlocks
  };
}

/** All SQLite the form generates: catalog (data.db) + per-space entities mirror. */
function buildPreviewSqlite(
  state: BuilderState,
  query: QueryObject,
  composed: ComposedQuery,
  entitySqlite: string[]
): { text: string; blocks: Array<{ text: string; kind: "queries" | "spaces" | "entities" }> } {
  const blocks: Array<{ text: string; kind: "queries" | "spaces" | "entities" }> = [];

  if (isStepCreateQuery(query) || query.parameters.length > 0) {
    const queriesSql = composer.composeQueriesCatalogUpsertSql(
      {
        id: query.id,
        name: query.name,
        operation: query.operation,
        node_label: primaryNodeLabel(query),
        cypher: composed.cypher,
        sqlite: entitySqlite,
        parameters: composer.queryParametersForQueriesCatalog(query)
      },
      catalogRuntimeEnabled(state.query, state.runtimeEnabled)
    );
    if (queriesSql) {
      blocks.push({
        kind: "queries",
        text: formatPreviewSqlBlock(`-- catalog data.db: queries table\n${queriesSql}`)
      });
    }
  }

  const newLabels = collectCreateAttributiveLabels(query);
  if (query.operation === "create" && newLabels.length && state.spaceId) {
    const spaceSql = composer.composeSpaceLabelsUpdateSql(
      state.spaceId,
      state.spaceLabels,
      newLabels
    );
    if (spaceSql) {
      blocks.push({
        kind: "spaces",
        text: formatPreviewSqlBlock(`-- catalog data.db: spaces.labels\n${spaceSql}`)
      });
    }
  }

  entitySqlite.forEach((stmt, index) => {
    const header = index === 0 ? "-- space database: entities table\n" : "";
    blocks.push({
      kind: "entities",
      text: header ? formatPreviewSqlBlock(`${header}${stmt}`) : formatSqlForPreview(stmt)
    });
  });

  return {
    text: blocks.length ? blocks.map((b) => b.text).join("\n\n") : "(none)",
    blocks
  };
}

export function primaryNodeLabel(query: QueryObject): string {
  return query.match[0]?.label ?? "STEP";
}

function splitCypher(cypher: string): string[] {
  return cypher
    .split(/\s*;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const builderSelectors = {
  warnings: (state: BuilderState): string[] => {
    const warnings = validateQuery(
      state.query,
      catalogRuntimeEnabled(state.query, state.runtimeEnabled)
    );
    // Surface real-time attributive_label uniqueness conflicts as warnings.
    const hasDuplicate = Object.entries(state.checks).some(
      ([key, check]) =>
        key.startsWith("al:") &&
        isActiveCheckKey(key, state.query) &&
        check.status === "duplicate"
    );
    if (hasDuplicate) {
      warnings.push("An attributive_label is already taken — choose another.");
    }
    // Surface INSTANCE is_key uniqueness conflicts.
    const hasKeyConflict = Object.entries(state.checks).some(
      ([key, check]) =>
        key.startsWith("ikey:") &&
        isActiveCheckKey(key, state.query) &&
        check.status === "duplicate"
    );
    if (hasKeyConflict) {
      warnings.push("A key property value is already taken — choose another.");
    }
    const hasBodyJsonError = Object.entries(state.checks).some(
      ([key, check]) =>
        key.startsWith("stepBody:") &&
        isActiveCheckKey(key, state.query) &&
        check.status === "error"
    );
    if (hasBodyJsonError) {
      warnings.push("STEP request body must be valid JSON.");
    }
    // Update-INSTANCE schema guard: explain why Run is blocked (the block itself is
    // enforced through checksAllClear) and surface the non-blocking blast-radius note.
    const isUpdateInstance =
      state.query.operation === "update" && state.query.match[0]?.label === "INSTANCE";
    if (isUpdateInstance) {
      const guard = state.checks["uguard"];
      if (guard && guard.status === "error" && guard.message) {
        warnings.push(guard.message);
      }
      const guardInfo = state.checks["uguardInfo"];
      if (guardInfo && guardInfo.status !== "idle" && guardInfo.message) {
        warnings.push(guardInfo.message);
      }
    }
    return warnings;
  },

  showRunButton: (state: BuilderState): boolean =>
    isEntityConfigUpdate(state.query.operation, state.query.match[0]?.label) ||
    isRunnableEndpointStepCreate(state.query) ||
    !queryUsesParameters(state.query),

  canCreate: (state: BuilderState): boolean =>
    state.query.operation === "create" &&
    Boolean(state.spaceId) &&
    // Custom-endpoint STEP creates store $param tokens verbatim in the entity payload
    // (substituted at sequence runtime), so they may run even though they use parameters.
    (isRunnableEndpointStepCreate(state.query) || !queryUsesParameters(state.query)) &&
    validateQuery(state.query, catalogRuntimeEnabled(state.query, state.runtimeEnabled))
      .length === 0 &&
    checksAllClear(state.checks, state.query) &&
    state.run.status !== "running",

  canRun: (state: BuilderState): boolean =>
    Boolean(state.spaceId) &&
    // STEP/SCHEMA config updates and custom-endpoint STEP creates persist $param tokens
    // verbatim into the entity payload, so they run even though they "use parameters".
    (isEntityConfigUpdate(state.query.operation, state.query.match[0]?.label) ||
      isRunnableEndpointStepCreate(state.query) ||
      !queryUsesParameters(state.query)) &&
    validateQuery(state.query, catalogRuntimeEnabled(state.query, state.runtimeEnabled))
      .length === 0 &&
    checksAllClear(state.checks, state.query) &&
    state.run.status !== "running",

  canSaveOperation: (state: BuilderState): boolean => {
    return (
      Boolean(state.spaceId) &&
      validateQuery(state.query, false).length === 0 &&
      checksAllClear(state.checks, state.query) &&
      state.run.status !== "running"
    );
  }
};
