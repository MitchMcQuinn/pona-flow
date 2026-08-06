/**
 * Diagnostic: parameterized target in CREATE INSTANCE.
 *
 * The target of a create-INSTANCE operation may be an existing instance whose id is
 * supplied at run time: the UI stores node_source "existing" with
 * id_binding = { key: "id", value: "$target" } (the attributive_label convention).
 *
 *  1. The existing-node MATCH emits a bind parameter ({ id: $target }), never a
 *     quoted '$target' literal, so the engine can bind the resolved value at run time.
 *  2. SQLite entity statements never leak "$target" as a literal id.
 *  3. A concrete existing target still composes a quoted literal id (unchanged).
 *
 * Run:  npx tsx tests/instance-target-parameter.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

// New instance node adopted from the CAR schema (implicit UID key row hydrated by the UI).
const newCarProperties = [
  {
    key: "car_uid",
    value: "ID_new_car",
    schematic_properties: {
      value_type: "UID",
      is_required: true,
      is_key: true,
      is_label: false,
      is_indexed: false
    }
  },
  {
    key: "MODEL",
    value: "Sedan",
    schematic_properties: {
      value_type: "string",
      is_required: true,
      is_key: false,
      is_label: false,
      is_indexed: false
    }
  }
];

function createInstanceQuery(targetId) {
  return {
    id: "q-target-param",
    name: "target-param",
    operation: "create",
    allow_duplicates: false,
    parameters:
      targetId === "$target"
        ? [
            {
              name: "target",
              data_type: "string",
              value: "",
              is_required: true,
              schematic_properties: { value_type: "string", format: "any", is_required: true }
            }
          ]
        : [],
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "target",
                  attributive_label: "PERSON",
                  node_source: "existing",
                  id_binding: { key: "id", value: targetId },
                  properties: []
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "ID_owns",
                  attributive_label: "OWNS",
                  node_source: "new",
                  id_binding: { key: "id", value: "ID_owns" },
                  properties: []
                }
              },
              {
                kind: "node",
                node: {
                  variable: "ID_new_car",
                  attributive_label: "CAR",
                  node_source: "new",
                  properties: newCarProperties
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

// --- 1. parameterized target: MATCH binds $target, no quoted '$target' anywhere ---
{
  const out = composer.composeQuery(createInstanceQuery("$target"));

  assert.match(
    out.cypher,
    /MATCH \(target:INSTANCE \{ id: \$target \}\)/,
    "existing-target MATCH binds the run-time parameter"
  );
  assert.doesNotMatch(
    out.cypher,
    /'\$target'/,
    "the parameter reference must never be a quoted string literal"
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(out.parameters, "target"),
    "composed parameters carry the target binding"
  );

  // SQLite entity statements must never leak "$target" as a literal id (INSTANCE
  // rows are graph-only, so this list is expected to be empty here).
  for (const stmt of out.sqlite) {
    assert.ok(!stmt.includes("$target"), `sqlite must not leak the parameter: ${stmt}`);
  }

  console.log("ok: parameterized target ->", out.cypher.split("\n")[0]);
}

// --- 2. concrete existing target: quoted literal id (unchanged behavior) ---
{
  const out = composer.composeQuery(createInstanceQuery("ID_person"));

  assert.match(
    out.cypher,
    /MATCH \(target:INSTANCE \{ id: 'ID_person' \}\)/,
    "concrete existing target still matches by quoted literal id"
  );

  console.log("ok: concrete target ->", out.cypher.split("\n")[0]);
}

console.log("instance-target-parameter: ok");
