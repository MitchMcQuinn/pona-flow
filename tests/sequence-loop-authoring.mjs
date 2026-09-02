/**
 * Authoring-side loop rules, exercised without a live engine.
 *
 * A loop is two halves: the cycle is drawn in the graph, and the sequence type says when
 * it stops. Only the second half is authored as data, and this covers that half on the
 * client — the shape validation that blocks a save, the normalization that decides what
 * reaches the `loop_config` column, and the MCP argument translation.
 *
 * The rules mirror Engine/server/execution_loop.py, which is the enforcing side, so the
 * messages and the accepted operator set are asserted to match rather than merely to
 * exist. Graph-level checks (exactly one cycle, real RETURN aliases, no nesting) are
 * deliberately *not* here: they need the POINTS_TO edges, which only compose can see.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_LOOP_CONFIG,
  DEFAULT_MAX_ITERATIONS,
  LOOP_COMPARISON_OPERATORS,
  LOOP_TYPES,
  LOOP_TYPE_LABELS,
  isDagLoop,
  isLoopType,
  loopConfigWarnings,
  normalizeLoopConfig,
} from "../App/authoring/src/index.ts";
import { buildLoopConfig } from "../App/mcp/src/index.ts";

// --- The vocabulary matches the engine's ---

assert.deepEqual(
  [...LOOP_TYPES],
  ["dag", "for", "for_while", "for_each"],
  "the four types must match execution_loop.LOOP_TYPES"
);
assert.deepEqual(
  [...LOOP_COMPARISON_OPERATORS],
  ["=", "<>", "<", "<=", ">", ">=", "CONTAINS", "STARTS WITH", "ENDS WITH"],
  "operators must match execution_loop.COMPARISON_OPERATORS"
);
assert.equal(DEFAULT_MAX_ITERATIONS, 1000, "must match execution_loop.DEFAULT_MAX_ITERATIONS");
for (const type of LOOP_TYPES) {
  assert.ok(LOOP_TYPE_LABELS[type], `${type} needs a label for the selector`);
}

assert.ok(isLoopType("for_each"));
assert.ok(!isLoopType("spiral"));
assert.ok(!isLoopType(undefined));

// --- dag is the default and means "no loop data at all" ---

assert.equal(DEFAULT_LOOP_CONFIG.type, "dag");
assert.ok(isDagLoop(undefined), "an absent config is a dag");
assert.ok(isDagLoop({ type: "dag" }));
assert.ok(!isDagLoop({ type: "for", count: 1 }));
assert.equal(
  normalizeLoopConfig({ type: "dag" }),
  undefined,
  "a dag writes no loop_config, so existing sequences are untouched"
);
assert.equal(normalizeLoopConfig(undefined), undefined);
assert.deepEqual(loopConfigWarnings(undefined), [], "a dag needs no configuration");

// --- Normalization drops the other types' scratch state ---
// The builder keeps every type's inputs mounted so switching back and forth doesn't lose
// what was typed; this is what stops that reaching the catalog.

const switched = normalizeLoopConfig({
  type: "for",
  count: 3,
  source: "leftoverAlias",
  condition: { parameter: "leftoverParam", operator: "=", value: "true" },
});
assert.deepEqual(switched, { type: "for", count: 3 }, "only the selected type's fields persist");

assert.deepEqual(normalizeLoopConfig({ type: "for_each", source: "  rowId  " }), {
  type: "for_each",
  source: "rowId",
});
assert.deepEqual(
  normalizeLoopConfig({ type: "for_while", condition: { parameter: " hasMore " } }),
  { type: "for_while", condition: { parameter: "hasMore", operator: "=", value: "" } },
  "an operator defaults rather than being left unset"
);
assert.deepEqual(normalizeLoopConfig({ type: "for", count: 2, max_iterations: 50 }), {
  type: "for",
  count: 2,
  max_iterations: 50,
});
assert.equal(
  normalizeLoopConfig({ type: "for", count: 2, max_iterations: 0 }).max_iterations,
  undefined,
  "a zero cap is dropped so the engine's default applies"
);

// --- Shape validation blocks a save the engine would reject ---

assert.deepEqual(loopConfigWarnings({ type: "for", count: 5 }), []);
assert.deepEqual(loopConfigWarnings({ type: "for", count: 0 }), [], "zero passes is legal");
assert.equal(
  loopConfigWarnings({ type: "for" }).length,
  1,
  "a for loop with no count is incomplete"
);
assert.equal(loopConfigWarnings({ type: "for", count: -1 }).length, 1);
assert.equal(loopConfigWarnings({ type: "for", count: 1.5 }).length, 1);
assert.match(
  loopConfigWarnings({ type: "for", count: 5000, max_iterations: 100 })[0],
  /exceeds this sequence's maximum/,
  "a count past the cap is caught before the run hits it"
);

assert.equal(
  loopConfigWarnings({ type: "for_while", condition: { parameter: "", operator: "=", value: "" } })
    .length,
  1,
  "a for/while loop needs something to test"
);
assert.deepEqual(
  loopConfigWarnings({
    type: "for_while",
    condition: { parameter: "hasMore", operator: "=", value: "true" },
  }),
  [],
  "an empty value is legal — comparing against the empty string is meaningful"
);
assert.equal(
  loopConfigWarnings({
    type: "for_while",
    condition: { parameter: "hasMore", operator: "≈", value: "true" },
  }).length,
  1,
  "an operator outside the shared set is rejected"
);

assert.equal(loopConfigWarnings({ type: "for_each" }).length, 1);
assert.equal(loopConfigWarnings({ type: "for_each", source: "   " }).length, 1);
assert.deepEqual(loopConfigWarnings({ type: "for_each", source: "entityId" }), []);

// --- MCP arguments -> loop_config ---

assert.equal(buildLoopConfig(undefined), undefined, "no loop argument means a dag");
assert.equal(buildLoopConfig({ type: "dag" }), undefined);
assert.equal(buildLoopConfig({ type: "spiral" }), undefined, "an unknown type degrades to dag");

assert.deepEqual(buildLoopConfig({ type: "for", count: 4 }), { type: "for", count: 4 });
assert.deepEqual(
  buildLoopConfig({ type: "for" }),
  { type: "for", count: 0 },
  "an omitted count is zero, not undefined, so the engine sees a complete config"
);
assert.deepEqual(
  buildLoopConfig({
    type: "for_while",
    condition: { parameter: "hasMore", operator: ">", value: "0" },
    max_iterations: 25,
  }),
  {
    type: "for_while",
    max_iterations: 25,
    condition: { parameter: "hasMore", operator: ">", value: "0" },
  }
);
assert.deepEqual(buildLoopConfig({ type: "for_each", source: "entityId" }), {
  type: "for_each",
  source: "entityId",
});

// A stored loop_config round-trips through the same translator, which is how
// update_sequence preserves the rule when its `loop` argument is omitted.
const stored = { type: "for_each", source: "entityId", max_iterations: 200 };
assert.deepEqual(buildLoopConfig(stored), stored, "a saved config survives a partial update");

console.log("sequence-loop-authoring: ok");
