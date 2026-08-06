/**
 * Diagnostic: reusable SCHEMA relationship types.
 *
 * A relationship attributive_label is a reusable type: multiple POINTS_TO edges may
 * share it, each with its own id and an identical schemata payload copy in SQLite.
 *
 *  1. Reusing a type between a new node pair composes a MERGE with the *fresh* edge id
 *     and an entities INSERT carrying a copy of the shared schemata.
 *  2. Updating a SCHEMA relationship targets every copy by common_label (not id).
 *  3. Updating a STEP relationship stays id-keyed (STEP labels may repeat with
 *     independent payloads).
 *
 * Run:  npx tsx tests/schema-rel-type-reuse.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

// Shared definition of the HAS type, as hydrated by the UI from fetchSchemaDefinition
// (implicit is_key UID filtered out — the composer re-injects it at payload time).
const hasTypeProperties = [
  {
    key: "SINCE",
    value: "",
    schematic_properties: {
      value_type: "string",
      is_required: true,
      is_key: false,
      is_label: false,
      is_indexed: false
    }
  }
];

// --- 1. SCHEMA create reusing the HAS type between a new node pair ---
{
  const q = {
    id: "q-reuse",
    name: "reuse",
    operation: "create",
    allow_duplicates: false,
    parameters: [],
    match: [
      {
        label: "SCHEMA",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "p",
                  attributive_label: "PERSON",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_person" },
                  properties: []
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "ID_new_edge",
                  attributive_label: "HAS",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_new_edge" },
                  properties: hasTypeProperties
                }
              },
              {
                kind: "node",
                node: {
                  variable: "c",
                  attributive_label: "CAR",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_car" },
                  properties: []
                }
              }
            ]
          }
        ]
      }
    ]
  };
  const out = composer.composeQuery(q);

  // The MERGE must bind the fresh edge id, never the picked edge's id.
  assert.match(
    out.cypher,
    /\[ID_new_edge:POINTS_TO \{[^}]*id: 'ID_new_edge'[^}]*\}\]/,
    "MERGE binds the fresh edge id"
  );
  assert.match(
    out.cypher,
    /\[ID_new_edge:POINTS_TO \{[^}]*attributive_label: 'HAS'[^}]*\}\]/,
    "MERGE carries the reused type label"
  );

  // The entities INSERT copies the shared definition for the new edge id.
  const relInsert = out.sqlite.find(
    (s) => /^INSERT INTO entities /.test(s) && s.includes("'ID_new_edge'")
  );
  assert.ok(relInsert, "entities INSERT for the new edge present");
  assert.match(relInsert, /'SCHEMA'/, "row kind is SCHEMA");
  assert.match(relInsert, /'HAS'/, "common_label is the type label");
  assert.match(relInsert, /"name":"SINCE"/, "copied schemata include the type property");
  assert.match(
    relInsert,
    /"name":"id","value_type":"UID"[^}]*"is_key":true/,
    "implicit UID key re-injected so the copy matches the type's other edges"
  );
  console.log("ok: reuse type ->", relInsert);
}

// --- 2. update SCHEMA relationship: payload UPDATE targets all copies by common_label ---
{
  const q = {
    id: "q-rel-update",
    name: "rel-update",
    operation: "update",
    parameters: [],
    match: [
      {
        label: "SCHEMA",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "ID_person",
                  attributive_label: "PERSON",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_person" },
                  properties: []
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "ID_r1",
                  attributive_label: "HAS",
                  type: "POINTS_TO",
                  node_source: "existing",
                  id_binding: { key: "id", value: "ID_r1" },
                  properties: hasTypeProperties
                }
              },
              {
                kind: "node",
                node: { variable: "ID_car", attributive_label: "CAR", properties: [] }
              }
            ]
          }
        ]
      }
    ]
  };
  const out = composer.composeQuery(q);
  assert.equal(out.cypher, "", "update SCHEMA rel must emit no cypher");
  // The relationship's payload is the one carrying the type's SINCE property (the
  // PERSON node update also contains "schemata", but only the implicit id key).
  const relUpdate = out.sqlite.find(
    (s) => /^UPDATE entities /.test(s) && s.includes('"name":"SINCE"')
  );
  assert.ok(relUpdate, "relationship UPDATE present");
  assert.match(
    relUpdate,
    /WHERE node_label = 'SCHEMA' AND common_label = 'HAS';$/,
    "SCHEMA relationship update syncs every copy of the type"
  );
  assert.doesNotMatch(relUpdate, /WHERE id = /, "must not key on a single edge id");
  console.log("ok: update SCHEMA rel ->", relUpdate);
}

// --- 3. update STEP relationship: still keyed by id ---
{
  const q = {
    id: "q-step-rel-update",
    name: "step-rel-update",
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
  const relUpdate = out.sqlite.find((s) => s.includes("'ID_rel1'"));
  assert.ok(relUpdate, "STEP relationship UPDATE present");
  assert.match(relUpdate, /WHERE id = 'ID_rel1';$/, "STEP rel update stays id-keyed");
  console.log("ok: update STEP rel ->", relUpdate);
}

console.log("schema-rel-type-reuse: ok");
