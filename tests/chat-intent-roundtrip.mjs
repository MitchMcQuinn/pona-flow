/**
 * A chat intent saved by applyChatIntents is the same artifact the visual builder saves.
 *
 * The compiler now lives in @pona-flow/authoring. This drives that save with the flat
 * fields propose_change carries, then recomposes the stored builder_config. If the
 * snapshot did not recompose to the Cypher that was saved, opening the proposal in the
 * builder would change it.
 */

import assert from "node:assert/strict";

import { applyChatIntents, normalizeForCompose, previewChatIntent } from "../App/authoring/src/index.ts";
import connector from "../App/connector/src/index.ts";
import { followUpPrompt } from "../App/ui/src/chat/followUp.ts";
import composer from "./helpers/composer.mjs";

const SPACE_ID = "space-chat-intent";
const queries = new Map();
const stepNodes = new Map();
const stepWraps = new Map();
const createLabels = [];
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
    return json(row);
  }
  if (path === "/api/execute-create") {
    const labels = body.attributive_labels ?? [];
    createLabels.push(labels);
    for (const label of labels) {
      stepNodes.set(label, { id: (body.attributive_label_owner_ids ?? [])[0] ?? "" });
    }
    return json({ ok: true, result: { cypher: [] } });
  }
  return json({ error: `unhandled ${method} ${path}` }, 500);
}

connector.configure({ apiBase: "http://fake.local", fetch: fakeFetch, headers: () => ({}) });

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

const item = {
  kind: "upsert_schema",
  summary: "Create customer",
  payload: {
    name: "Create customer",
    description: "Mint the customer schema.",
    attributive_label: "customer record",
    properties: [
      { name: "id", value_type: "UID", is_key: true, is_required: true },
      { name: "email_address", value_type: "string", is_required: true, is_key: true },
      { key: "name", is_label: true },
    ],
  },
};

const preview = previewChatIntent(item);
assert.equal(preview.sequence, false);
assert.equal(preview.query.operation, "create");
assert.equal(preview.query.match[0].patterns[0].path[0].node.attributive_label, "customer_record");
assert.deepEqual(
  preview.query.match[0].patterns[0].path[0].node.properties.map((property) => property.key).sort(),
  ["email_address", "name"]
);

const saved = await applyChatIntents(SPACE_ID, [item]);
assert.equal(saved.ok, true, saved.failed?.error);
assert.ok(saved.applied[0].id);

const pkg = queries.get(saved.applied[0].id);
assert.equal(pkg.kind, "operation");
assert.equal(pkg.builder_config.version, 1);
assert.equal(pkg.builder_config.query.operation, "create");
assert.equal(
  pkg.builder_config.query.match[0].patterns[0].path[0].node.attributive_label,
  "customer_record"
);

const recomposed = composer.composeQuery(normalizeForCompose(pkg.builder_config.query));
assert.deepEqual(
  recomposedStatements(recomposed.cypher),
  pkg.cypher,
  "reopening the chat intent in the builder must recompose the Cypher that was saved"
);
assert.deepEqual(
  composer.queryParametersForQueriesCatalog(normalizeForCompose(pkg.builder_config.query)),
  pkg.parameters
);

createLabels.length = 0;
stepNodes.clear();
const sameName = {
  kind: "upsert_schema",
  summary: "Create ENTITY schema",
  payload: {
    attributive_label: "entity",
    properties: [{ key: "name", is_label: true }],
  },
};
const entitySaved = await applyChatIntents(SPACE_ID, [sameName]);
assert.equal(entitySaved.ok, true, entitySaved.failed?.error);
const written = createLabels.flat();
assert.ok(written.includes("entity"), "the SCHEMA node is still named entity");
assert.ok(written.includes("create_entity"), "the wrapping STEP takes a different name");
assert.equal(
  createLabels.some((labels) => labels.includes("entity") && labels.includes("create_entity")),
  false,
  "the wrap and the schema are not claimed in the same write"
);
const entityPkg = queries.get(entitySaved.applied[0].id);
assert.equal(entityPkg.name, "create_entity");
assert.equal(
  entityPkg.builder_config.query.match[0].patterns[0].path[0].node.attributive_label,
  "entity"
);

const prompt = followUpPrompt({
  ok: true,
  validation_errors: [],
  applied: [
    {
      kind: "create_agent_key",
      summary: "worker stg_abcDEF-123",
      id: "key-1",
      token: "stg_abcDEF-123",
    },
  ],
  failed: null,
  not_applied: [],
  created_space_id: null,
});
assert.equal(prompt.includes("stg_"), false);
assert.match(prompt, /\[token hidden\]/);
