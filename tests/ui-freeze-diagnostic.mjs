/**
 * Diagnostic: UI freeze — self-triggering state-update loops in the builder.
 *
 * The builder has three places where an effect rewrites the query in response to a
 * query change. Each is safe only if the rewrite reaches a fixpoint; if any of them
 * keeps producing a "new" query for the same input, React re-renders in a loop and
 * the UI freezes (or, for the debounced ones, refetches + repatches forever).
 *
 *  1. QueryCard: patchQuery(syncParametersFromReferences) on every query change.
 *     Must reach a fixpoint (return the same object) within a couple of passes.
 *  2. useCreateInstanceSchemaSync: reconcileCreateInstanceQuery on every MATCH
 *     change (debounced + schema fetches). Must return null once settled.
 *  3. Graph canvas: projectMatchToGraph -> serializeMatchGraph re-derives the
 *     clause on every structural edit. Serialization must be stable (a second
 *     round-trip yields an identical clause) or the canvas topoKey oscillates.
 *  4. Perf smoke: LivePreview reformats composed SQL on every keystroke; the
 *     INSERT/UPDATE regexes must stay fast on large schemata payloads.
 *
 * Run:  npx tsx tests/ui-freeze-diagnostic.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";

import {
  collectParameterOriginMeta,
  collectReferencedParameterNames,
  syncParametersFromReferences
} from "../App/ui/src/state/builder/parameterRefs.ts";
import { reconcileCreateInstanceQuery } from "../App/ui/src/state/builder/createInstanceSync.ts";
import {
  projectMatchToGraph,
  serializeMatchGraph
} from "../App/ui/src/state/builder/matchGraph.ts";
import { propertiesFromSchemata } from "../App/ui/src/state/builder/schemaRules.ts";
import { formatSqlForPreview } from "../App/ui/src/utils/formatSqlForPreview.ts";

const MAX_SYNC_PASSES = 5;

/** Apply an updater the way the QueryCard effect does, asserting it reaches a fixpoint. */
function assertFixpoint(name, query, apply) {
  let current = query;
  for (let pass = 1; pass <= MAX_SYNC_PASSES; pass++) {
    const next = apply(current);
    if (next === current || next === null) {
      console.log(`ok: ${name} reached fixpoint after ${pass - 1} rewrite(s)`);
      return next === null ? current : next;
    }
    current = next;
  }
  assert.fail(
    `${name} did not reach a fixpoint within ${MAX_SYNC_PASSES} passes — ` +
      "this effect loops forever in the UI (renders/dispatches on every pass)"
  );
}

function schematic(overrides = {}) {
  return {
    value_type: "string",
    format: "any",
    is_required: false,
    is_key: false,
    is_label: false,
    is_indexed: false,
    ...overrides
  };
}

function baseQuery(overrides = {}) {
  return {
    id: "q-diag",
    name: "diag",
    operation: "create",
    allow_duplicates: false,
    parameters: [],
    match: [],
    ...overrides
  };
}

// --- 1. QueryCard parameter sync: fixpoint for every parameter origin kind ---

// 1a. Parameterized existing-instance target (the new id_binding "$target" flow).
{
  const query = baseQuery({
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
                  attributive_label: "GROUP",
                  node_source: "existing",
                  id_binding: { key: "id", value: "$target" },
                  properties: []
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "r1",
                  attributive_label: "HAS",
                  node_source: "new",
                  id_binding: { key: "id", value: "ID_r1" },
                  properties: []
                }
              },
              {
                kind: "node",
                node: {
                  variable: "n2",
                  attributive_label: "TASK",
                  node_source: "new",
                  properties: [
                    {
                      key: "TITLE",
                      value: "$title",
                      schematic_properties: schematic({ is_required: true })
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const refs = collectReferencedParameterNames(query);
  assert.deepEqual(refs, ["target", "title"], "id_binding + property $refs are collected");

  const meta = collectParameterOriginMeta(query);
  assert.equal(meta.get("target")?.is_required, true, "$target origin is required+locked");
  assert.equal(meta.get("target")?.locked, true);

  const settled = assertFixpoint("param sync (instance $target)", query, (q) =>
    syncParametersFromReferences(q)
  );
  assert.equal(settled.parameters.length, 2, "both parameters materialize exactly once");
}

// 1b. SCHEMA create with choice-type property params (options/min/max inheritance).
{
  const query = baseQuery({
    match: [
      {
        label: "SCHEMA",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "s1",
                  attributive_label: "$label",
                  node_source: "new",
                  id_binding: { key: "id", value: "ID_s1" },
                  properties: [
                    {
                      key: "$key",
                      value: "$size",
                      schematic_properties: schematic({
                        value_type: "checkbox",
                        format: undefined,
                        options: ["S", "M", "L"],
                        min_choices: 1,
                        max_choices: 2,
                        is_required: true
                      })
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ],
    skip: { parameter: "offset" },
    limit: { parameter: "page_size" },
    return: {
      items: [{ expression: "s1.NAME", alias: "$out", path_variable: "", property_key: "" }]
    }
  });

  const settled = assertFixpoint("param sync (schema create, choice types)", query, (q) =>
    syncParametersFromReferences(q)
  );
  assert.deepEqual(
    settled.parameters.map((p) => p.name),
    ["key", "label", "offset", "out", "page_size", "size"],
    "all origin kinds collected once, sorted"
  );
  // Re-entry with user edits preserved: change an unlocked field, sync again.
  const edited = {
    ...settled,
    parameters: settled.parameters.map((p) =>
      p.name === "out" ? { ...p, description: "user note" } : p
    )
  };
  const resettled = assertFixpoint("param sync (after user edit)", edited, (q) =>
    syncParametersFromReferences(q)
  );
  assert.equal(
    resettled.parameters.find((p) => p.name === "out")?.description,
    "user note",
    "sync must not clobber user edits (a clobber + re-edit cycle freezes typing)"
  );
}

// --- 2. create-INSTANCE schema reconcile: idempotent (returns null once settled) ---
{
  const groupSchemata = [
    { key: "GROUP_UID", value_type: "UID", is_required: true, is_key: true, is_label: false, is_indexed: false },
    { key: "NAME", value_type: "string", is_required: true, is_key: false, is_label: true, is_indexed: false },
    { key: "COLOR", value_type: "radio", is_required: false, is_key: false, is_label: false, is_indexed: false, options: ["red", "blue"] }
  ];
  const relSchemata = [
    { key: "SINCE", value_type: "string", is_required: false, is_key: false, is_label: false, is_indexed: false }
  ];

  // Node hydrated against an OLDER schema: has a deleted property (LEGACY, fed by a
  // parameter) and is missing the new COLOR property.
  const query = baseQuery({
    parameters: [
      {
        name: "legacy",
        data_type: "string",
        value: "",
        is_required: false,
        schematic_properties: schematic()
      }
    ],
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "g1",
                  attributive_label: "GROUP",
                  node_source: "new",
                  properties: [
                    {
                      key: "GROUP_UID",
                      value: "ID_g1",
                      schematic_properties: schematic({ value_type: "UID", is_key: true, is_required: true })
                    },
                    {
                      key: "LEGACY",
                      value: "$legacy",
                      schematic_properties: schematic()
                    }
                  ]
                }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "r1",
                  attributive_label: "HAS",
                  node_source: "new",
                  id_binding: { key: "id", value: "ID_r1" },
                  properties: propertiesFromSchemata(relSchemata).filter(
                    (p) => !p.schematic_properties?.is_key
                  )
                }
              },
              {
                kind: "node",
                node: {
                  variable: "t1",
                  attributive_label: "TASK",
                  node_source: "existing",
                  id_binding: { key: "id", value: "$target" },
                  properties: []
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const nodeSchemata = new Map([["GROUP", groupSchemata]]);
  const relMap = new Map([["GROUP\u0000HAS", relSchemata]]);

  const first = reconcileCreateInstanceQuery(query, nodeSchemata, relMap);
  assert.ok(first, "drifted snapshot is reconciled (adds COLOR, drops LEGACY)");
  const g1 = first.match[0].patterns[0].path[0].node;
  assert.ok(g1.properties.some((p) => p.key === "COLOR"), "new schema property appended");
  assert.ok(!g1.properties.some((p) => p.key === "LEGACY"), "deleted property stripped");
  assert.ok(
    !first.parameters.some((p) => p.name === "legacy"),
    "orphaned parameter pruned"
  );

  // The hook's contract: once settled, every subsequent pass must return null.
  // A non-null here means the 300ms-debounced effect refetches + repatches forever
  // (matches a freeze + endless /api/schema/outgoing + nodes-by-label request bursts).
  assertFixpoint("create-INSTANCE reconcile", first, (q) =>
    reconcileCreateInstanceQuery(q, nodeSchemata, relMap)
  );

  // Reconcile + param sync must not fight each other (sync re-adds what reconcile
  // prunes only if still referenced; both must settle together).
  let combined = first;
  for (let i = 0; i < MAX_SYNC_PASSES; i++) {
    const afterSync = syncParametersFromReferences(combined);
    const afterReconcile = reconcileCreateInstanceQuery(afterSync, nodeSchemata, relMap);
    const next = afterReconcile ?? afterSync;
    if (next === combined) {
      console.log(`ok: reconcile + param sync settle together after ${i} pass(es)`);
      combined = next;
      break;
    }
    assert.ok(i < MAX_SYNC_PASSES - 1, "reconcile and param sync ping-pong forever");
    combined = next;
  }
}

// --- 3. match graph project/serialize round-trip stability ---
{
  const node = (variable, extras = {}) => ({
    kind: "node",
    node: {
      variable,
      attributive_label: variable.toUpperCase(),
      node_source: "new",
      alias_mode: "define",
      properties: [],
      ...extras
    }
  });
  const ref = (variable) => ({
    kind: "node",
    node: {
      variable,
      alias_mode: "reference",
      alias_ref: variable,
      alias_locked: true,
      attributive_label: variable.toUpperCase(),
      properties: []
    }
  });
  const rel = (variable, extras = {}) => ({
    kind: "relationship",
    relationship: {
      variable,
      attributive_label: "POINTS_TO",
      alias_mode: "define",
      direction: "outgoing",
      properties: [],
      ...extras
    }
  });

  const scenarios = {
    linear: [{ path: [node("a"), rel("r1"), node("b"), rel("r2"), node("c")] }],
    branch: [
      { path: [node("a"), rel("r1"), node("b")] },
      { path: [ref("a"), rel("r2"), node("c")] }
    ],
    cycle: [
      { path: [node("a"), rel("r1"), node("b")] },
      { path: [ref("b"), rel("r2"), ref("a")] }
    ],
    selfLoop: [{ path: [node("a"), rel("r1"), ref("a")] }],
    parallelEdges: [
      { path: [node("a"), rel("r1"), node("b")] },
      { path: [ref("a"), rel("r2"), ref("b")] }
    ],
    isolated: [{ path: [node("a")] }, { path: [node("b")] }]
  };

  for (const [name, patterns] of Object.entries(scenarios)) {
    const query = baseQuery({
      operation: "read",
      match: [{ label: "STEP", patterns }]
    });
    const started = Date.now();
    const graph1 = projectMatchToGraph(query, 0);
    const clause1 = serializeMatchGraph(graph1, query.match[0]);
    const graph2 = projectMatchToGraph({ ...query, match: [clause1] }, 0);
    const clause2 = serializeMatchGraph(graph2, clause1);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `${name}: round-trip must be fast (took ${elapsed}ms)`);
    assert.equal(
      graph1.nodes.length,
      graph2.nodes.length,
      `${name}: node count survives a round-trip`
    );
    assert.equal(
      graph1.edges.length,
      graph2.edges.length,
      `${name}: edge count survives a round-trip`
    );
    assert.equal(
      JSON.stringify(clause2),
      JSON.stringify(clause1),
      `${name}: serialization must be stable — an oscillating clause re-keys the ` +
        "canvas topoKey and rebuilds the d3 sim on every render"
    );
    console.log(`ok: match graph round-trip stable (${name})`);
  }
}

// --- 4. live-preview SQL formatter perf smoke (runs on every keystroke) ---
{
  // A realistic worst case: an entities INSERT whose payload column carries a large
  // schemata JSON blob (kilobytes of quoted text), plus an ON CONFLICT tail.
  const bigPayload = JSON.stringify(
    Array.from({ length: 400 }, (_, i) => ({
      property_schema: {
        name: `PROP_${i}`,
        value_type: "string",
        is_required: i % 2 === 0,
        is_key: false,
        is_label: false,
        is_indexed: false,
        default_value: `value ${i} with some text, commas, and 'quotes'`
      }
    }))
  ).replace(/'/g, "''");
  const stmt =
    `INSERT INTO entities (id, space_id, payload) VALUES ('ID_x', 'SPACE', '${bigPayload}') ` +
    `ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, space_id = excluded.space_id;`;

  const started = Date.now();
  for (let i = 0; i < 20; i++) formatSqlForPreview(stmt);
  const elapsed = Date.now() - started;
  console.log(
    `ok: formatSqlForPreview 20x on ${(stmt.length / 1024).toFixed(1)}KB statement in ${elapsed}ms`
  );
  assert.ok(
    elapsed < 2000,
    `formatSqlForPreview too slow (${elapsed}ms for 20 calls) — LivePreview runs it per keystroke`
  );
}

console.log("ui-freeze-diagnostic: ok");
