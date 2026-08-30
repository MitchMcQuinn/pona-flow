/**
 * RETURN boolean projections (read/update INSTANCE): a projection may return the
 * result of a comparison instead of the property value.
 *
 * Covers the compiled Cypher (null-safe coalesce wrapping, the bare IS NULL form,
 * literal vs $parameter right-hand sides), the round-trip hints readReturnItemPatch
 * stores, the validateQuery gates, and the $parameter a comparison value registers.
 *
 * Run from App/ui: `npx tsx ../../tests/return-boolean-expression.mjs`
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import {
  collectReadMatchPathBindings,
  readReturnItemPatch,
  resolvedReadReturnFields
} from "../App/authoring/src/returnProjections.ts";
import { validateQuery } from "../App/authoring/src/validation.ts";
import {
  collectReferencedParameterNames,
  collectParameterOriginMeta
} from "../App/authoring/src/parameterRefs.ts";

function personQuery(items) {
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
    return: { distinct: false, items }
  };
}

const bindings = collectReadMatchPathBindings(personQuery([]));
assert.equal(bindings.length, 1);
assert.equal(bindings[0].variable, "p");

function booleanItem(operator, value, alias = "flag") {
  return {
    ...readReturnItemPatch(bindings, "p", "AGE", { booleanMode: true, operator, value }),
    alias
  };
}

// ---- compiled expression ----

// A numeric literal stays bare inside a null-safe wrapper: a PERSON with no AGE
// must project false, not null, so the column is always a strict boolean.
assert.equal(booleanItem(">", "30").expression, "coalesce(p.AGE > 30, false)");
assert.equal(booleanItem("<=", "1.5").expression, "coalesce(p.AGE <= 1.5, false)");

// Strings are quoted, booleans and null are not (mirrors the WHERE filter literals).
assert.equal(
  readReturnItemPatch(bindings, "p", "STATUS", {
    booleanMode: true,
    operator: "=",
    value: "active"
  }).expression,
  "coalesce(p.STATUS = 'active', false)"
);
assert.equal(
  readReturnItemPatch(bindings, "p", "ACTIVE", {
    booleanMode: true,
    operator: "=",
    value: "true"
  }).expression,
  "coalesce(p.ACTIVE = true, false)"
);

// An exact $parameter binds through Neo4j rather than being quoted as a literal.
assert.equal(
  booleanItem(">", "$threshold").expression,
  "coalesce(p.AGE > $threshold, false)"
);

// Partial-match operators compile the same way.
assert.equal(
  readReturnItemPatch(bindings, "p", "NAME", {
    booleanMode: true,
    operator: "CONTAINS",
    value: "an"
  }).expression,
  "coalesce(p.NAME CONTAINS 'an', false)"
);

// IS NULL / IS NOT NULL are already total, so no coalesce guard and no value.
assert.equal(booleanItem("IS NULL", "").expression, "p.AGE IS NULL");
assert.equal(booleanItem("IS NOT NULL", "ignored").expression, "p.AGE IS NOT NULL");

// Incomplete rows compile to "" so validateQuery reports them instead of emitting
// half-formed Cypher.
assert.equal(booleanItem(">", "").expression, "");
assert.equal(booleanItem(undefined, "30").expression, "");
assert.equal(
  readReturnItemPatch(bindings, "p", "", { booleanMode: true, operator: ">", value: "30" })
    .expression,
  ""
);

// Boolean mode off is unchanged, and leaves every comparison hint unset so
// projections saved before this feature re-save byte-identically.
const plain = readReturnItemPatch(bindings, "p", "AGE");
assert.equal(plain.expression, "p.AGE");
assert.equal(plain.boolean_mode, undefined);
assert.equal(plain.comparison_operator, undefined);
assert.equal(plain.comparison_value, undefined);

// ---- round-trip hints ----

const stored = booleanItem(">", "$threshold", "is_adult");
assert.equal(stored.boolean_mode, true);
assert.equal(stored.comparison_operator, ">");
assert.equal(stored.comparison_value, "$threshold");
assert.equal(stored.path_variable, "p");
assert.equal(stored.property_key, "AGE");
assert.equal(stored.attributive_label, "PERSON");

const reopened = resolvedReadReturnFields(stored, bindings);
assert.equal(reopened.boolean_mode, true);
assert.equal(reopened.comparison_operator, ">");
assert.equal(reopened.comparison_value, "$threshold");
assert.equal(reopened.path_variable, "p");
assert.equal(reopened.property_key, "AGE");

// Toggling off clears the comparison rather than leaving it dangling behind the expression.
const toggledOff = readReturnItemPatch(bindings, "p", "AGE", { booleanMode: false });
assert.equal(toggledOff.expression, "p.AGE");
assert.equal(toggledOff.boolean_mode, undefined);
assert.equal(toggledOff.comparison_operator, undefined);
assert.equal(toggledOff.comparison_value, undefined);

// ---- composed Cypher ----

const composed = composer.composeQuery(personQuery([booleanItem(">", "30", "is_adult")]));
assert.match(composed.cypher, /RETURN coalesce\(p\.AGE > 30, false\) AS is_adult/);

// ---- validation ----

assert.deepEqual(validateQuery(personQuery([booleanItem(">", "30", "is_adult")]), false), []);

const noAlias = validateQuery(
  personQuery([{ ...booleanItem(">", "30"), alias: undefined }]),
  false
);
assert.ok(noAlias.some((w) => w.includes("a boolean projection needs an alias")));

const noOperator = validateQuery(personQuery([booleanItem(undefined, "30")]), false);
assert.ok(noOperator.some((w) => w.includes("select a comparison operator")));

const noValue = validateQuery(personQuery([booleanItem(">", "")]), false);
assert.ok(noValue.some((w) => w.includes("enter a value to compare against")));

// A valueless operator needs no value, so it must not trip the value gate.
assert.deepEqual(validateQuery(personQuery([booleanItem("IS NULL", "")]), false), []);

// A plain projection is untouched by the boolean gates.
assert.deepEqual(
  validateQuery(personQuery([readReturnItemPatch(bindings, "p", "AGE")]), false),
  []
);

// ---- parameter registration ----

const parameterized = personQuery([booleanItem(">", "$threshold", "is_adult")]);
assert.deepEqual(collectReferencedParameterNames(parameterized), ["threshold"]);
const origin = collectParameterOriginMeta(parameterized).get("threshold");
// Required (the comparison cannot run without it) and locked, but the value_type stays
// editable so the author can match it to the property being compared.
assert.equal(origin.is_required, true);
assert.equal(origin.locked, true);
assert.equal(origin.value_type, undefined);

console.log("return-boolean-expression: ok");
