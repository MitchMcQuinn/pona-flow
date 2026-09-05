/**
 * The load-bearing claim of the authoring gateway: an operation an agent creates is the
 * same artifact a human creates in the visual builder, and stays editable there.
 *
 * A saved package's composed Cypher is forward-only — there is no decompiler — so the
 * builder reopens an operation from the `builder_config` snapshot stored alongside it. If
 * an agent-authored operation saved a snapshot that did not recompose to the Cypher that
 * was actually saved, the operation would silently change the moment someone opened and
 * re-saved it in the UI. That is what this test rules out, by driving the real MCP tools
 * end to end and then recomposing what came back.
 *
 * The engine is replaced with an in-memory fake so the test is deterministic and needs no
 * Neo4j. The fake stores whatever the connector sends and returns it verbatim, which is
 * exactly the contract the real catalog honours for `builder_config`.
 */

import assert from "node:assert/strict";

import { normalizeForCompose } from "../App/authoring/src/index.ts";
import { connectTestClient } from "../App/mcp/src/testing.ts";
import connector from "../App/connector/src/index.ts";
import composer from "./helpers/composer.mjs";

const SPACE_ID = "space-roundtrip";

// --- In-memory engine ---

const calls = [];
const queries = new Map();
const stepNodes = new Map(); // attributive_label -> { id, sequencial_properties }
const stepWraps = new Map(); // operation id -> entity id
const executed = [];
let idCounter = 0;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fakeFetch(url, init = {}) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });

  if (path === "/api/generate-id") {
    idCounter += 1;
    return json({ id: `id-${idCounter}` });
  }

  if (path === "/api/graph/nodes-by-label") {
    const nodeLabel = parsed.searchParams.get("node_label");
    if (nodeLabel !== "STEP") return json({ nodes: [] });
    return json({
      nodes: [...stepNodes.entries()].map(([attributive_label, node]) => ({
        attributive_label,
        ...node,
      })),
    });
  }
  if (path === "/api/graph/attributive-label-exists") {
    return json({ exists: stepNodes.has(parsed.searchParams.get("attributive_label")) });
  }
  if (path === "/api/graph/id-exists") return json({ exists: false });
  if (path === "/api/graph/instance-property-exists") return json({ exists: false });
  if (path === "/api/graph/step-wrap-entity-id") {
    return json({ entity_id: stepWraps.get(parsed.searchParams.get("operation_id")) || "" });
  }

  if (path === "/api/queries/upsert") {
    queries.set(body.id, body);
    return json({ id: body.id });
  }
  if (path === "/api/queries" && method === "GET") {
    return json({ queries: [...queries.values()] });
  }
  if (path.startsWith("/api/queries/")) {
    const id = decodeURIComponent(path.slice("/api/queries/".length));
    const row = queries.get(id);
    if (!row) return json({ error: `no query ${id}` }, 404);
    // The catalog returns the stored package; builder_config travels back verbatim.
    return json({
      id: row.id,
      name: row.name,
      cypher: row.cypher,
      sqlite: row.sqlite,
      parameters: row.parameters,
      builder_config: row.builder_config ?? {},
    });
  }

  if (path === "/api/execute-create") {
    executed.push(body);
    // Mirror the STEP wrap the engine would have written, so a later save of the same
    // operation resolves its own entity instead of minting a second one.
    for (const label of body.attributive_labels ?? []) {
      stepNodes.set(label, { id: (body.attributive_label_owner_ids ?? [])[0] ?? "" });
    }
    return json({ ok: true, result: { cypher: [] } });
  }

  return json({ error: `unhandled ${method} ${path}` }, 500);
}

connector.configure({ apiBase: "http://fake.local", fetch: fakeFetch, headers: () => ({}) });

const { client, close } = await connectTestClient({
  apiBase: "http://fake.local",
  spaceId: SPACE_ID,
  agentKey: "",
});

function parse(result) {
  assert.equal(result.isError, undefined, `tool failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

function recomposedStatements(cypher) {
  return cypher
    .split(/\s*;\s*\n/)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"))
        .join(" ")
    )
    .filter(Boolean);
}

// --- Catalog query (SCHEMA): same artifact a human saves, snapshot recomposes ---

const createdSchema = parse(
  await client.callTool({
    name: "create_operation",
    arguments: {
      name: "Create customer",
      description: "Mint the customer schema.",
      group_title: "Fulfilment",
      operation: "create",
      node_label: "SCHEMA",
      attributive_label: "customer record",
      schema_properties: [
        { key: "email address", value_type: "string", is_required: true, is_key: true },
        { key: "name", is_label: true },
      ],
    },
  })
);
assert.equal(createdSchema.ok, true);
assert.ok(createdSchema.operation_id, "the query is saved under a catalog id");

const schemaUpsertIndex = calls.findIndex(
  (c) => c.path === "/api/queries/upsert" && c.body?.kind === "operation"
);
const schemaWrapIndex = calls.findIndex((c) => c.path === "/api/execute-create");
assert.ok(schemaUpsertIndex >= 0, "the catalog row is saved");
assert.ok(schemaWrapIndex > schemaUpsertIndex, "the STEP wrap happens after the catalog row exists");

const fetched = parse(
  await client.callTool({
    name: "get_operation",
    arguments: { operation_id: createdSchema.operation_id },
  })
);
const pkg = fetched.operation;
const snapshot = pkg.builder_config;

assert.equal(snapshot.version, 1, "a builder_config snapshot came back");
assert.ok(snapshot.query, "the snapshot carries the QueryObject");
assert.equal(snapshot.query.id, createdSchema.operation_id);
assert.equal(snapshot.query.operation, "create");

const recomposed = composer.composeQuery(normalizeForCompose(snapshot.query));
assert.deepEqual(
  recomposedStatements(recomposed.cypher),
  pkg.cypher,
  "reopening the query in the builder must recompose the exact Cypher that was saved"
);
assert.deepEqual(
  composer.queryParametersForQueriesCatalog(normalizeForCompose(snapshot.query)),
  pkg.parameters,
  "and the exact parameter contract"
);

const schemaNode = snapshot.query.match[0].patterns[0].path[0].node;
assert.equal(schemaNode.attributive_label, "CUSTOMER_RECORD");

const before = queries.get(createdSchema.operation_id);
const updated = parse(
  await client.callTool({
    name: "update_operation",
    arguments: { operation_id: createdSchema.operation_id, query: snapshot.query },
  })
);
assert.equal(updated.operation_id, createdSchema.operation_id);
const after = queries.get(createdSchema.operation_id);
assert.deepEqual(
  after.cypher,
  before.cypher,
  "re-saving an unmodified snapshot must not change the composed Cypher"
);
assert.deepEqual(after.builder_config, before.builder_config, "nor the snapshot");

// --- Create STEP (HTTP): publish the designed step, do not save a factory ---

calls.length = 0;
const createdStep = parse(
  await client.callTool({
    name: "create_operation",
    arguments: {
      name: "Log shipment",
      description: "Record that a shipment left the warehouse.",
      group_title: "Fulfilment",
      operation: "create",
      node_label: "STEP",
      attributive_label: "log shipment call",
      http_step: {
        endpoint: "https://example.test/shipments",
        method: "POST",
        body: { tracking: "$tracking" },
        response_parameters: [{ property_path: "data.id", parameter: "shipment_id" }],
      },
      parameters: [{ name: "tracking", is_required: true }],
    },
  })
);
assert.equal(createdStep.ok, true);
assert.equal(createdStep.operation_id, null, "create STEP does not mint a catalog factory");
assert.equal(createdStep.executed, true, "the designed STEP is materialized");
assert.equal(createdStep.step_attributive_label, "LOG_SHIPMENT_CALL");
assert.ok(createdStep.sequence_id, "add_as_sequence defaults to a one-step sequence");

const stepCreateIndex = calls.findIndex((c) => c.path === "/api/execute-create");
const stepSeqUpsert = calls.findIndex(
  (c) => c.path === "/api/queries/upsert" && c.body?.kind === "sequence"
);
assert.ok(stepCreateIndex >= 0, "the designed STEP is written");
assert.ok(stepSeqUpsert > stepCreateIndex, "the one-step sequence is saved after the STEP exists");
assert.equal(
  calls.filter((c) => c.path === "/api/queries/upsert" && c.body?.kind === "operation").length,
  0,
  "create STEP must not upsert a kind=operation factory"
);

const oneStep = queries.get(createdStep.sequence_id);
assert.equal(oneStep.kind, "sequence");
assert.equal(oneStep.name, "Log shipment");
assert.match(
  oneStep.cypher.join(" "),
  /attributive_label: 'LOG_SHIPMENT_CALL'/,
  "the sequence MATCHES the designed STEP, not a wrap of the create-query"
);

assert.ok(stepNodes.has("LOG_SHIPMENT_CALL"), "the designed STEP is in the graph");

// --- Wiring two published steps and sequencing them ---

parse(
  await client.callTool({
    name: "create_operation",
    arguments: {
      name: "Notify customer",
      operation: "create",
      node_label: "STEP",
      attributive_label: "notify customer call",
      http_step: { endpoint: "https://example.test/notify", method: "POST" },
    },
  })
);

const transition = parse(
  await client.callTool({
    name: "create_step_transition",
    arguments: {
      from_step: "LOG_SHIPMENT_CALL",
      to_step: "NOTIFY_CUSTOMER_CALL",
      relationship_label: "then notify",
    },
  })
);
assert.equal(transition.ok, true);
const edgeWrite = executed.at(-1);
assert.match(edgeWrite.cypher.join(" "), /MATCH \(LOG_SHIPMENT_CALL:STEP \{ id: '/);
assert.match(edgeWrite.cypher.join(" "), /MATCH \(NOTIFY_CUSTOMER_CALL:STEP \{ id: '/);
assert.match(
  edgeWrite.cypher.join(" "),
  /MERGE \(LOG_SHIPMENT_CALL\)-\[THEN_NOTIFY:POINTS_TO \{[^}]*\}\]->\(NOTIFY_CUSTOMER_CALL\)/,
  "the relationship label is normalized to UPPER_SNAKE"
);

const sequence = parse(
  await client.callTool({
    name: "create_sequence",
    arguments: {
      entry_step: "LOG_SHIPMENT_CALL",
      name: "Ship and notify",
      group_title: "Fulfilment",
      description: "Log a shipment, then notify the customer.",
    },
  })
);
const sequenceRow = queries.get(sequence.sequence_id);
assert.equal(sequenceRow.kind, "sequence");
assert.equal(sequenceRow.triggerable, true);
assert.match(
  sequenceRow.cypher.join(" "),
  /MATCH path = \(:STEP \{ attributive_label: 'LOG_SHIPMENT_CALL' \}\)-\[\*\]->/,
  "a sequence must traverse downstream, or it would run only its entry step"
);

// A transition targeting a step that does not exist fails loudly instead of silently
// creating an empty node the sequence would then walk into.
const missing = await client.callTool({
  name: "create_step_transition",
  arguments: { from_step: "LOG_SHIPMENT_CALL", to_step: "NOT_A_STEP", relationship_label: "NOPE" },
});
assert.equal(missing.isError, true);
assert.match(JSON.parse(missing.content[0].text).error, /No STEP node named/);

await close();
connector.resetConfig();

console.log("mcp-authoring-roundtrip: ok");
