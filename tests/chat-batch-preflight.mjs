/**
 * A proposal is checked with the builder's preflight before anything is written.
 * Schemas in the same batch count, so a seed can adopt them, and the read's wrap
 * STEP counts, so a link can point at it. A name that is already a step does not
 * get written under a different label.
 *
 * Run: ./node_modules/.bin/tsx ../../tests/chat-batch-preflight.mjs  (from App/ui)
 */

import assert from "node:assert/strict";

import { applyChatIntents, preflightChatItems } from "../App/authoring/src/index.ts";
import connector from "../App/connector/src/index.ts";

const SPACE_ID = "space-preflight";
let idCounter = 0;
let steps = [];
let writes = 0;

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
  if (path === "/api/generate-id") {
    idCounter += 1;
    return json({ id: `id-${idCounter}` });
  }
  if (path === "/api/schema/definition") {
    return json({ error: "missing schema" }, 404);
  }
  if (path === "/api/graph/nodes-by-label") return json({ nodes: steps });
  if (path === "/api/graph/attributive-label-exists") return json({ exists: false });
  if (path === "/api/graph/id-exists") return json({ exists: false });
  if (path === "/api/graph/instance-property-exists") return json({ exists: false });
  if (path === "/api/queries/upsert" || path === "/api/execute-create") {
    writes += 1;
    return json({ ok: true, id: "saved", result: { cypher: [] } });
  }
  return json({ error: `unhandled ${method} ${path}` }, 500);
}

connector.configure({ apiBase: "http://fake.local", fetch: fakeFetch, headers: () => ({}) });

function schema(label) {
  return {
    kind: "upsert_schema",
    summary: `Type ${label}`,
    payload: {
      attributive_label: label,
      properties: [{ key: "name", value_type: "string", is_label: true }],
    },
  };
}

const read = {
  kind: "upsert_query",
  summary: "Load post",
  payload: {
    name: "read_post",
    kind: "operation",
    operation: "read",
    node_label: "INSTANCE",
    attributive_label: "post",
    add_as_sequence: false,
    hops: [
      { relationship_label: "post_author", target_label: "author", target_source: "existing" },
    ],
  },
};

const link = {
  kind: "upsert_query",
  summary: "Link post to author",
  payload: {
    name: "link_post_author",
    kind: "operation",
    operation: "create",
    node_label: "SCHEMA",
    attributive_label: "post",
    anchor_source: "existing",
    add_as_sequence: false,
    hops: [
      { relationship_label: "post_author", target_label: "author", target_source: "existing" },
    ],
  },
};

const decide = {
  kind: "upsert_query",
  summary: "Decide ready",
  payload: {
    name: "decide_ready",
    kind: "operation",
    operation: "create",
    node_label: "STEP",
    attributive_label: "decide_ready",
    add_as_sequence: false,
    operation_step: {
      name: "ready",
      groups: [{ statements: [{ x: "$ready", operator: "=", y: "yes" }] }],
    },
  },
};

const seed = {
  kind: "upsert_query",
  summary: "Starting rows",
  payload: {
    name: "seed_post",
    kind: "operation",
    operation: "create",
    node_label: "INSTANCE",
    attributive_label: "post",
    instance_properties: [{ key: "name", value: "Example" }],
    execute: true,
    add_as_sequence: false,
    hops: [
      {
        relationship_label: "post_author",
        target_label: "author",
        target_source: "new",
        instance_properties: [{ key: "name", value: "Related" }],
      },
    ],
  },
};

const chain = [
  schema("post"),
  schema("author"),
  link,
  read,
  decide,
  {
    kind: "create_transition",
    summary: "read_post to decide_ready",
    payload: { from_step: "read_post", to_step: "decide_ready", condition_type: "null" },
  },
  {
    kind: "upsert_query",
    summary: "Publish",
    payload: { name: "publish", kind: "sequence", entry_step: "read_post", traversal: "downstream" },
  },
  seed,
];

steps = [];
writes = 0;
const clear = await preflightChatItems(SPACE_ID, chain);
assert.deepEqual(clear, [], clear.join(" | "));
assert.equal(writes, 0);

const unschemed = await preflightChatItems(SPACE_ID, [seed]);
assert.match(unschemed.join("\n"), /No SCHEMA named "post"/);

const missing = await preflightChatItems(SPACE_ID, [
  {
    kind: "create_transition",
    summary: "nope to decide_ready",
    payload: { from_step: "nope", to_step: "decide_ready", condition_type: "null" },
  },
]);
assert.match(missing.join("\n"), /No STEP node named "nope"/);
assert.match(missing.join("\n"), /No STEP node named "decide_ready"/);

steps = [{ id: "old-read", attributive_label: "read_post" }];
writes = 0;
const collided = await applyChatIntents(SPACE_ID, [read, decide, chain[5]]);
assert.equal(collided.ok, false);
assert.deepEqual(collided.applied, []);
assert.equal(writes, 0);
assert.match(collided.failed.error, /read_post1/);
assert.match(collided.failed.error, /points at "read_post"/);
