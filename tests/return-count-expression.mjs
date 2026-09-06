/**
 * RETURN count projections (read/update INSTANCE): a projection may return
 * count(alias.prop) — the number of matched values — instead of the property.
 *
 * Covers the compiled Cypher, mutual exclusion with boolean_mode, the round-trip
 * hints readReturnItemPatch stores, and the validateQuery gates.
 *
 * Run from App/ui: `npx tsx ../../tests/return-count-expression.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import {
  collectReadMatchPathBindings,
  readReturnItemPatch,
  resolvedReadReturnFields
} from "../App/authoring/src/returnProjections.ts";
import { validateQuery } from "../App/authoring/src/validation.ts";

function personQuery(items, extra = {}) {
  return {
    id: "q1",
    name: "people",
    operation: "read",
    parameters: [],
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: { variable: "p", attributive_label: "PERSON", properties: [] }
              }
            ]
          }
        ]
      }
    ],
    return: { distinct: false, items },
    ...extra
  };
}

const bindings = collectReadMatchPathBindings(personQuery([]));
assert.equal(bindings.length, 1);
assert.equal(bindings[0].variable, "p");

function countItem(alias = "result_count") {
  return {
    ...readReturnItemPatch(bindings, "p", "AGE", { countMode: true }),
    alias
  };
}

// ---- compiled expression ----

assert.equal(countItem().expression, "count(p.AGE)");
assert.equal(
  readReturnItemPatch(bindings, "p", "STATUS", { countMode: true }).expression,
  "count(p.STATUS)"
);

// Incomplete rows compile to "" so validateQuery reports them instead of emitting
// half-formed Cypher.
assert.equal(
  readReturnItemPatch(bindings, "p", "", { countMode: true }).expression,
  ""
);

// Count mode off is unchanged, and leaves every mode hint unset so projections
// saved before this feature re-save byte-identically.
const plain = readReturnItemPatch(bindings, "p", "AGE");
assert.equal(plain.expression, "p.AGE");
assert.equal(plain.boolean_mode, undefined);
assert.equal(plain.count_mode, undefined);
assert.equal(plain.comparison_operator, undefined);
assert.equal(plain.comparison_value, undefined);

// ---- round-trip hints ----

const stored = countItem("person_count");
assert.equal(stored.count_mode, true);
assert.equal(stored.boolean_mode, undefined);
assert.equal(stored.comparison_operator, undefined);
assert.equal(stored.comparison_value, undefined);
assert.equal(stored.path_variable, "p");
assert.equal(stored.property_key, "AGE");
assert.equal(stored.attributive_label, "PERSON");

const reopened = resolvedReadReturnFields(stored, bindings);
assert.equal(reopened.count_mode, true);
assert.equal(reopened.boolean_mode, false);
assert.equal(reopened.path_variable, "p");
assert.equal(reopened.property_key, "AGE");

// Toggling off restores the bare property and clears the count hint.
const toggledOff = readReturnItemPatch(bindings, "p", "AGE", { countMode: false });
assert.equal(toggledOff.expression, "p.AGE");
assert.equal(toggledOff.count_mode, undefined);

// ---- mutual exclusion with boolean_mode ----

// Switching to count from a boolean comparison drops the comparison, not just the flag.
const fromBoolean = readReturnItemPatch(bindings, "p", "AGE", {
  booleanMode: false,
  countMode: true,
  operator: ">",
  value: "30"
});
assert.equal(fromBoolean.expression, "count(p.AGE)");
assert.equal(fromBoolean.count_mode, true);
assert.equal(fromBoolean.boolean_mode, undefined);
assert.equal(fromBoolean.comparison_operator, undefined);
assert.equal(fromBoolean.comparison_value, undefined);

// Switching to boolean from count compiles the comparison and clears count.
const fromCount = readReturnItemPatch(bindings, "p", "AGE", {
  booleanMode: true,
  countMode: true,
  operator: ">",
  value: "30"
});
assert.equal(fromCount.expression, "coalesce(p.AGE > 30, false)");
assert.equal(fromCount.boolean_mode, true);
assert.equal(fromCount.count_mode, undefined);

// ---- composed Cypher ----

const composed = composer.composeQuery(personQuery([countItem("person_count")]));
assert.match(composed.cypher, /RETURN count\(p\.AGE\) AS person_count/);

const updateComposed = composer.composeQuery(
  personQuery([countItem("person_count")], {
    operation: "update",
    set: [{ expression: "p.AGE = 1" }]
  })
);
assert.match(updateComposed.cypher, /SET p\.AGE = 1/);
assert.match(updateComposed.cypher, /RETURN count\(p\.AGE\) AS person_count/);

// ---- validation ----

assert.deepEqual(validateQuery(personQuery([countItem("person_count")]), false), []);

const noAlias = validateQuery(personQuery([{ ...countItem(), alias: undefined }]), false);
assert.ok(noAlias.some((w) => w.includes("a count projection needs an alias")));

const bothModes = validateQuery(
  personQuery([
    {
      ...countItem("flag"),
      boolean_mode: true,
      comparison_operator: ">",
      comparison_value: "30"
    }
  ]),
  false
);
assert.ok(
  bothModes.some((w) => w.includes("return boolean and return count cannot both be active"))
);

// A plain projection is untouched by the count gates.
assert.deepEqual(
  validateQuery(personQuery([readReturnItemPatch(bindings, "p", "AGE")]), false),
  []
);

console.log("return-count-expression: ok");
