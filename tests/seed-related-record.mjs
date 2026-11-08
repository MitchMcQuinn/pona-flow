/**
 * A seed create that also writes the related record must give that record its schema key.
 * The key check used to see only the first node, so Starting rows failed and the rest
 * of the plan was left unapplied.
 *
 * Run: ./node_modules/.bin/tsx ../../tests/seed-related-record.mjs  (from App/ui)
 */

import assert from "node:assert/strict";

import { applyChatIntents } from "../App/authoring/src/index.ts";
import connector from "../App/connector/src/index.ts";

const SPACE_ID = "space-seed";
let idCounter = 0;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function schemaFor(label) {
  return {
    space_id: SPACE_ID,
    schema_id: `schema-${label}`,
    attributive_label: label,
    schemata: [
      {
        key: "id",
        value_type: "UID",
        is_required: true,
        is_key: true,
        is_label: false,
        is_indexed: false,
      },
      {
        key: "name",
        value_type: "string",
        is_required: false,
        is_key: false,
        is_label: true,
        is_indexed: false,
      },
    ],
  };
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
    return json(schemaFor(parsed.searchParams.get("attributive_label") || "record"));
  }
  if (path === "/api/graph/nodes-by-label") return json({ nodes: [] });
  if (path === "/api/graph/attributive-label-exists") return json({ exists: false });
  if (path === "/api/graph/id-exists") return json({ exists: false });
  if (path === "/api/graph/instance-property-exists") return json({ exists: false });
  if (path === "/api/graph/step-wrap-entity-id") return json({ entity_id: "" });
  if (path === "/api/queries/upsert") return json({ id: "saved-seed" });
  if (path === "/api/execute-create") return json({ ok: true, result: { cypher: [] } });
  return json({ error: `unhandled ${method} ${path}` }, 500);
}

connector.configure({ apiBase: "http://fake.local", fetch: fakeFetch, headers: () => ({}) });

const seeded = await applyChatIntents(SPACE_ID, [
  {
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
  },
]);

assert.equal(seeded.ok, true, seeded.failed?.error);
assert.equal(seeded.failed, null);
assert.deepEqual(seeded.not_applied, []);
