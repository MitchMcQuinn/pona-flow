/**
 * The extraction of the authoring logic out of the React builder must not have changed
 * what gets written.
 *
 * Two things are checked. First, a golden AuthoringContext still composes to exactly the
 * cypher / sqlite / parameters it did before the move — the values below are pinned, so any
 * drift in the payload builders fails here rather than silently changing what a save writes.
 * Second, the UI adapter re-exports the identical function objects from the authoring
 * package rather than keeping a divergent copy, which is what makes "the agent and the
 * builder do the same thing" true by construction instead of by review.
 */

import assert from "node:assert/strict";

import {
  buildCreateBodyWithOptions,
  buildQueriesCatalogPayload,
  cypherParamsFromQuery,
  cypherStatementsForExecution,
  entitySqliteStatements,
  newMatchClause,
  newQuery,
  newSchematicProperties,
  normalizeForCompose,
  serializeBuilderConfig,
  validateQuery,
} from "../App/authoring/src/index.ts";
import * as uiExecute from "../App/ui/src/services/execute.ts";
import composer from "./helpers/composer.mjs";

// --- A golden create-SCHEMA context, the shape the builder produces on "Create operation" ---

function goldenSchemaContext() {
  const query = newQuery("create");
  query.id = "op-golden-schema";
  query.name = "CREATE_CUSTOMER";
  const clause = newMatchClause("SCHEMA");
  clause.patterns[0].path[0].node = {
    variable: "CUSTOMER",
    alias_mode: "define",
    node_source: "new",
    attributive_label: "CUSTOMER",
    id_binding: { key: "id", value: "ent-customer-1" },
    properties: [
      {
        key: "EMAIL",
        value: "",
        schematic_properties: {
          ...newSchematicProperties(),
          format: "email",
          is_required: true,
          is_key: true,
        },
      },
      {
        key: "NAME",
        value: "",
        schematic_properties: { ...newSchematicProperties(), is_label: true },
      },
    ],
  };
  query.match = [clause];
  return { spaceId: "space-golden", query, runtimeEnabled: true };
}

const ctx = goldenSchemaContext();

assert.deepEqual(validateQuery(ctx.query, true), [], "the golden context must be valid");

const composed = composer.composeQuery(normalizeForCompose(ctx.query));

assert.deepEqual(
  cypherStatementsForExecution(composed.cypher),
  ["MERGE (CUSTOMER:SCHEMA { attributive_label: 'CUSTOMER', id: 'ent-customer-1' }) RETURN *"],
  "create-SCHEMA composes to a single MERGE keyed on the graph id"
);

const body = buildCreateBodyWithOptions(ctx, { includeQueriesCatalog: false });
assert.equal(body.space_id, "space-golden");
assert.equal(body.node_label, "SCHEMA");
assert.deepEqual(body.cypher, cypherStatementsForExecution(composed.cypher));
assert.deepEqual(body.sqlite, entitySqliteStatements(composed.sqlite));
assert.deepEqual(body.cypher_params, {});
assert.deepEqual(body.attributive_labels, ["CUSTOMER"]);
assert.deepEqual(
  body.attributive_label_owner_ids,
  ["ent-customer-1"],
  "the owner id lets the server tell a re-save apart from a collision"
);
assert.equal(body.queries_catalog, undefined, "a direct run must not write the catalog");
assert.equal(body.sqlite.length, 1, "the SCHEMA mirrors into exactly one entities row");
assert.match(body.sqlite[0], /^INSERT INTO entities/);
assert.equal(
  body.sqlite.some((statement) => /INSERT\s+INTO\s+queries\s/i.test(statement)),
  false,
  "catalog upserts are stripped out of the entity statements"
);

// --- The catalog payload carries a builder_config that round-trips ---

const catalog = buildQueriesCatalogPayload(ctx, true, { name: "CREATE_CUSTOMER" });
assert.equal(catalog.id, "op-golden-schema");
assert.equal(catalog.name, "CREATE_CUSTOMER");
assert.equal(catalog.kind, "operation");
assert.equal(catalog.operation, "create");
assert.equal(catalog.runtime_enabled, true);
assert.equal(catalog.space_id, "space-golden");
assert.deepEqual(catalog.cypher, cypherStatementsForExecution(composed.cypher));
assert.deepEqual(catalog.builder_config, serializeBuilderConfig(ctx, true));
assert.equal(catalog.builder_config.version, 1);
assert.deepEqual(
  catalog.builder_config.query,
  ctx.query,
  "the snapshot is the QueryObject verbatim, so the builder can reopen it"
);

// Recomposing from the stored snapshot yields the same statements: this is the property
// that makes an agent-authored operation editable in the visual builder.
const rehydrated = composer.composeQuery(normalizeForCompose(catalog.builder_config.query));
assert.equal(rehydrated.cypher, composed.cypher);
assert.deepEqual(rehydrated.sqlite, composed.sqlite);

// --- Parameter binding: booleans are coerced, everything else passes through ---

const paramCtx = { ...ctx, query: { ...ctx.query } };
paramCtx.query.parameters = [
  {
    name: "active",
    data_type: "string",
    value: "true",
    schematic_properties: { ...newSchematicProperties(), value_type: "boolean" },
  },
  { name: "note", data_type: "string", value: "hello" },
];
assert.deepEqual(
  cypherParamsFromQuery(paramCtx.query),
  { active: true, note: "hello" },
  "a boolean-declared parameter binds as a real boolean, not the string 'true'"
);

// --- The UI adapter must be the same code, not a copy ---

const shared = [
  "buildCreateBodyWithOptions",
  "buildQueriesCatalogPayload",
  "cypherStatementsForExecution",
  "entitySqliteStatements",
  "resaveOperationFromConfig",
  "runReadCypher",
  "createResponseToRunResult",
];
const authoring = await import("../App/authoring/src/index.ts");
for (const name of shared) {
  assert.equal(
    uiExecute[name],
    authoring[name],
    `services/execute.ts must re-export ${name} from @pona-flow/authoring, not redefine it`
  );
}

// The builder-facing wrappers stay, projecting BuilderState onto AuthoringContext.
assert.equal(typeof uiExecute.authoringContext, "function");
assert.deepEqual(
  uiExecute.authoringContext({
    spaceId: "space-golden",
    query: ctx.query,
    runtimeEnabled: true,
    matchPositions: { CUSTOMER: { x: 10, y: 20 } },
  }),
  { ...ctx, matchPositions: { CUSTOMER: { x: 10, y: 20 } } }
);

console.log("authoring-parity: ok");
