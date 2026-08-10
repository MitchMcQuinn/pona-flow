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

// --- Create an operation the way an agent would ---

const created = parse(
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
assert.equal(created.ok, true);
assert.ok(created.operation_id, "the operation is saved under a catalog id");

// The tool must have gone through the whole choreography, in order: save the catalog row,
// then wrap it in a STEP node. A wrap written before the row would reference nothing.
const upsertIndex = calls.findIndex((c) => c.path === "/api/queries/upsert");
const wrapIndex = calls.findIndex((c) => c.path === "/api/execute-create");
assert.ok(upsertIndex >= 0, "the catalog row is saved");
assert.ok(wrapIndex > upsertIndex, "the STEP wrap happens after the catalog row exists");

// --- Fetch it back and prove the snapshot recomposes identically ---

const fetched = parse(
  await client.callTool({
    name: "get_operation",
    arguments: { operation_id: created.operation_id },
  })
);
const pkg = fetched.operation;
const snapshot = pkg.builder_config;

assert.equal(snapshot.version, 1, "a builder_config snapshot came back");
assert.ok(snapshot.query, "the snapshot carries the QueryObject");
assert.equal(snapshot.query.id, created.operation_id);
assert.equal(snapshot.query.operation, "create");

const recomposed = composer.composeQuery(normalizeForCompose(snapshot.query));
const recomposedStatements = recomposed.cypher
  .split(/\s*;\s*\n/)
  .map((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .join(" ")
  )
  .filter(Boolean);

assert.deepEqual(
  recomposedStatements,
  pkg.cypher,
  "reopening the operation in the builder must recompose the exact Cypher that was saved"
);
assert.deepEqual(
  composer.queryParametersForQueriesCatalog(normalizeForCompose(snapshot.query)),
  pkg.parameters,
  "and the exact parameter contract"
);

// The STEP configuration survives the round trip, which is what makes the operation
// editable rather than merely re-runnable.
const node = snapshot.query.match[0].patterns[0].path[0].node;
assert.equal(node.attributive_label, "LOG_SHIPMENT_CALL");
assert.equal(node.sequencial_properties.endpoint, "https://example.test/shipments");
assert.equal(node.sequencial_properties.method, "POST");
assert.deepEqual(node.sequencial_properties.body, { tracking: "$tracking" });
assert.deepEqual(node.sequencial_properties.response_parameters, [
  { property_path: "data.id", parameter: "shipment_id" },
]);
assert.deepEqual(
  snapshot.query.parameters.map((p) => p.name),
  ["tracking"]
);

// --- Editing it back is idempotent ---

const before = queries.get(created.operation_id);
const updated = parse(
  await client.callTool({
    name: "update_operation",
    arguments: { operation_id: created.operation_id, query: snapshot.query },
  })
);
assert.equal(updated.operation_id, created.operation_id);
const after = queries.get(created.operation_id);
assert.deepEqual(
  after.cypher,
  before.cypher,
  "re-saving an unmodified snapshot must not change the composed Cypher"
);
assert.deepEqual(after.builder_config, before.builder_config, "nor the snapshot");

// --- Wiring two steps and sequencing them ---

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
      from_step: "Log shipment",
      to_step: "Notify customer",
      relationship_label: "then notify",
    },
  })
);
assert.equal(transition.ok, true);
// The endpoints are MATCHed by graph id and only then MERGEd together. A wrapping STEP
// node carries the operation's name verbatim ("Log shipment"), so the transition looks its
// id up rather than assuming a normalized label.
const edgeWrite = executed.at(-1);
assert.match(edgeWrite.cypher.join(" "), /MATCH \(Log_shipment:STEP \{ id: '/);
assert.match(edgeWrite.cypher.join(" "), /MATCH \(Notify_customer:STEP \{ id: '/);
assert.match(
  edgeWrite.cypher.join(" "),
  /MERGE \(Log_shipment\)-\[THEN_NOTIFY:POINTS_TO \{[^}]*\}\]->\(Notify_customer\)/,
  "the relationship label is normalized to UPPER_SNAKE even when the step names are not"
);

const sequence = parse(
  await client.callTool({
    name: "create_sequence",
    arguments: {
      entry_step: "Log shipment",
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
  /MATCH path = \(:STEP \{ attributive_label: 'Log shipment' \}\)-\[\*\]->/,
  "a sequence must traverse downstream, or it would run only its entry step"
);

// A transition targeting a step that does not exist fails loudly instead of silently
// creating an empty node the sequence would then walk into.
const missing = await client.callTool({
  name: "create_step_transition",
  arguments: { from_step: "Log shipment", to_step: "NOT_A_STEP", relationship_label: "NOPE" },
});
assert.equal(missing.isError, true);
assert.match(JSON.parse(missing.content[0].text).error, /No STEP node named/);

await close();
connector.resetConfig();

console.log("mcp-authoring-roundtrip: ok");
