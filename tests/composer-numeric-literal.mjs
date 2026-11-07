/**
 * Integer and number properties are authored as strings (form fields, chat apply).
 * The composer must render them as Cypher numbers. A quoted integer is stored as
 * text, and a later `property + 1` concatenates instead of adding.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function createQuery(property) {
  return {
    id: "q-numeric-literal",
    name: "Create count",
    operation: "create",
    parameters: [],
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
                  variable: "n1",
                  alias_mode: "define",
                  attributive_label: "COUNTER",
                  node_source: "new",
                  properties: [
                    {
                      key: "LABEL",
                      value: "6",
                      schematic_properties: { value_type: "string" },
                    },
                    property,
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const integer = composer.composeQuery(
  createQuery({
    key: "TICK",
    value: "6",
    schematic_properties: { value_type: "integer" },
  })
);
assert.match(integer.cypher, /TICK: 6\b/, "integer-declared '6' renders as a number");
assert.doesNotMatch(integer.cypher, /TICK: '6'/, "integer-declared '6' must not be quoted");
assert.match(integer.cypher, /LABEL: '6'/, "string-declared '6' stays quoted");

const decimal = composer.composeQuery(
  createQuery({
    key: "TICK",
    value: "1.5",
    schematic_properties: { value_type: "number" },
  })
);
assert.match(decimal.cypher, /TICK: 1\.5\b/, "number-declared '1.5' renders as a number");

const padded = composer.composeQuery(
  createQuery({
    key: "TICK",
    value: " 12 ",
    schematic_properties: { value_type: "integer" },
  })
);
assert.match(padded.cypher, /TICK: 12\b/, "surrounding spaces still parse as an integer");

const text = composer.composeQuery(
  createQuery({
    key: "TICK",
    value: "6 apples",
    schematic_properties: { value_type: "integer" },
  })
);
assert.match(text.cypher, /TICK: '6 apples'/, "non-numeric integer text stays quoted");

console.log("composer-numeric-literal: ok");
