/**
 * Diagnostic: author ON_EVENT_TRIGGER's UPDATE operation natively with the new
 * builder features (variable-length HAS_MANY hop 0..5, computed SET modes) and
 * verify the composed Cypher matches the semantics of the hand-patched catalog
 * version documented in Life OS docs/ACTION-TYPES-SETUP.md.
 *
 * The set items are generated through the real UI helpers (setItemPatch with
 * value_mode) so this also exercises the new expression-building code paths.
 *
 * Run from App/ui: npx tsx ../../tests/diag-on-event-trigger-native.mjs
 * Prints the composed statement on success (for the optional Neo4j EXPLAIN check).
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { normalizeForCompose } from "../App/ui/src/state/builder/selectors.ts";
import { collectReadMatchPathBindings } from "../App/ui/src/state/builder/returnProjections.ts";
import { setItemPatch } from "../App/ui/src/state/builder/setProjections.ts";

// The natively re-authored query: identical to the saved builder_config of
// query-mrz5nlw2-15, plus a second pattern (anchor alias-reference -> var-length
// HAS_MANY -> t) and mode-based SET items instead of the literal one.
const query = {
  id: "diag-on-event-trigger",
  name: "ON_EVENT_TRIGGER (native)",
  operation: "update",
  parameters: [
    {
      name: "eventId",
      data_type: "string",
      value: "",
      is_required: true,
      schematic_properties: {
        value_type: "string",
        format: "any",
        is_required: false,
        is_key: false,
        is_label: false,
        is_indexed: false
      }
    }
  ],
  match: [
    {
      label: "INSTANCE",
      optional: false,
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n40",
                alias_mode: "define",
                alias_locked: true,
                properties: [],
                attributive_label: "ACTION"
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r44",
                alias_mode: "define",
                alias_locked: true,
                type: "POINTS_TO",
                condition_type: "null",
                properties: [],
                attributive_label: "HAS_EVENT",
                direction: "outgoing"
              }
            },
            {
              kind: "node",
              node: {
                variable: "n43",
                alias_mode: "define",
                properties: [],
                attributive_label: "EVENT",
                where: {
                  operator: "AND",
                  items: [{ property_key: "id", operator: "=", value: "$eventId" }]
                }
              }
            }
          ]
        },
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "n40",
                alias_mode: "reference",
                alias_ref: "n40",
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "rhm",
                alias_mode: "define",
                type: "POINTS_TO",
                condition_type: "null",
                properties: [],
                attributive_label: "HAS_MANY",
                direction: "outgoing",
                // The new depth control writes this.
                length: { min: 0, max: 5 }
              }
            },
            {
              kind: "node",
              node: {
                variable: "t",
                alias_mode: "define",
                alias_locked: true,
                properties: [],
                attributive_label: "ACTION"
              }
            }
          ]
        }
      ]
    }
  ],
  return: {
    distinct: false,
    items: [
      { expression: "t", path_variable: "t", attributive_label: "ACTION", entity_role: "node" }
    ]
  },
  set: [],
  skip: null,
  limit: null,
  allow_duplicates: false,
  hide_duplicates: false
};

// Build the SET items through the real UI helpers (mode-based rows).
const bindings = collectReadMatchPathBindings(query);

// Guard rail check: the var-length alias must be flagged and thus excluded from pickers.
const rhmBinding = bindings.find((b) => b.variable === "rhm");
assert.equal(rhmBinding?.variableLength, true, "var-length alias should be flagged");

const isCompleteItem = {
  expression: "",
  ...setItemPatch(bindings, "t", "IS_COMPLETE", "", {
    mode: "not_property",
    sourceVariable: "r44",
    sourceProperty: "RESET_ON_EVENT"
  })
};
const lastModifiedItem = {
  expression: "",
  ...setItemPatch(bindings, "t", "LAST_MODIFIED", "", { mode: "now" })
};
query.set = [isCompleteItem, lastModifiedItem];

assert.equal(
  isCompleteItem.expression,
  "t.IS_COMPLETE = (NOT coalesce(r44.RESET_ON_EVENT, false))"
);
assert.equal(lastModifiedItem.expression, "t.LAST_MODIFIED = toString(datetime())");

const composed = composer.composeQuery(normalizeForCompose(query));
const cypher = composed.cypher;

// Variable-length range must precede the property map (render-order fix).
assert.match(cypher, /\[rhm:POINTS_TO\*0\.\.5 \{ attributive_label: 'HAS_MANY' \}\]/);
assert.match(cypher, /WHERE \(n43\.id = \$eventId\)/);
assert.match(cypher, /SET t\.IS_COMPLETE = \(NOT coalesce\(r44\.RESET_ON_EVENT, false\)\), t\.LAST_MODIFIED = toString\(datetime\(\)\)/);
assert.match(cypher, /RETURN t/);

console.log("diag-on-event-trigger-native: ok");
console.log("--- composed cypher ---");
console.log(cypher);
