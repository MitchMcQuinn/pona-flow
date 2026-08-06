/**
 * Diagnostic: update SCHEMA/STEP compose to a SQLite-only entity payload UPDATE
 * (no Cypher), keyed by the selected entity's id. STEP relationship guard conditions
 * are written into the entities payload.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function nodeUpdateQuery(label, node) {
  return {
    id: "q-cfg",
    name: "cfg",
    operation: "update",
    parameters: [],
    match: [{ label, patterns: [{ path: [{ kind: "node", node }] }] }]
  };
}

// --- update STEP node: custom-endpoint payload UPDATE, no cypher ---
{
  const q = nodeUpdateQuery("STEP", {
    variable: "ID_step1",
    attributive_label: "FETCH_USER",
    node_source: "existing",
    id_binding: { key: "id", value: "ID_step1" },
    properties: [],
    sequencial_properties: {
      endpoint: "https://api.example.com/u",
      method: "POST",
      headers: { Authorization: "Bearer $token" },
      body: { id: "$userId" }
    }
  });
  const out = composer.composeQuery(q);
  assert.equal(out.cypher, "", "update STEP must emit no cypher");
  assert.equal(out.sqlite.length, 1, "exactly one entity UPDATE");
  assert.match(out.sqlite[0], /^UPDATE entities SET /);
  assert.match(out.sqlite[0], /WHERE id = 'ID_step1';$/);
  assert.match(out.sqlite[0], /https:\/\/api\.example\.com\/u/);
  console.log("ok: update STEP node ->", out.sqlite[0]);
}

// --- update SCHEMA node: schemata payload UPDATE, no cypher ---
{
  const q = nodeUpdateQuery("SCHEMA", {
    variable: "ID_schema1",
    attributive_label: "USER",
    node_source: "existing",
    id_binding: { key: "id", value: "ID_schema1" },
    properties: [
      {
        key: "name",
        value: "",
        schematic_properties: {
          value_type: "string",
          is_required: true,
          is_key: false,
          is_label: false,
          is_indexed: false
        }
      }
    ]
  });
  const out = composer.composeQuery(q);
  assert.equal(out.cypher, "", "update SCHEMA must emit no cypher");
  assert.equal(out.sqlite.length, 1);
  assert.match(out.sqlite[0], /WHERE id = 'ID_schema1';$/);
  assert.match(out.sqlite[0], /"schemata"/);
  console.log("ok: update SCHEMA node ->", out.sqlite[0]);
}

// --- update STEP relationship: condition stored in payload ---
{
  const q = {
    id: "q-cfg-rel",
    name: "cfg-rel",
    operation: "update",
    parameters: [],
    match: [
      {
        label: "STEP",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "ID_a",
                  attributive_label: "A",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_a" },
                  properties: []
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "ID_rel1",
                  attributive_label: "NEXT",
                  type: "POINTS_TO",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_rel1" },
                  condition_type: "parameter",
                  condition: "shouldContinue",
                  properties: []
                }
              },
              {
                kind: "node",
                node: { variable: "ID_b", attributive_label: "B", properties: [] }
              }
            ]
          }
        ]
      }
    ]
  };
  const out = composer.composeQuery(q);
  assert.equal(out.cypher, "", "update STEP rel must emit no cypher");
  const relUpdate = out.sqlite.find((s) => /WHERE id = 'ID_rel1';$/.test(s));
  assert.ok(relUpdate, "relationship UPDATE present");
  assert.match(relUpdate, /"condition_type":"parameter"/);
  assert.match(relUpdate, /"condition":"shouldContinue"/);
  console.log("ok: update STEP rel ->", relUpdate);
}

console.log("ALL OK");
