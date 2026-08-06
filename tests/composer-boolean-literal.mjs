/**
 * A boolean-declared property authored in the builder arrives as the string
 * "true"/"false" (form fields yield strings). The composer must render it as a
 * Cypher boolean literal — a stored string 'true' never matches a boolean WHERE
 * filter (the CREATE_PROJECT IS_ACTIVE bug). String-declared properties and
 * unrecognized boolean text must keep rendering as quoted strings.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function createQuery(isActiveProperty) {
  return {
    id: "q-bool-literal",
    name: "Create project",
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
                  attributive_label: "PROJECT",
                  node_source: "new",
                  properties: [
                    {
                      key: "NAME",
                      value: "true",
                      schematic_properties: { value_type: "string" },
                    },
                    isActiveProperty,
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

const boolTrue = composer.composeQuery(
  createQuery({
    key: "IS_ACTIVE",
    value: "true",
    schematic_properties: { value_type: "boolean" },
  })
);
assert.match(
  boolTrue.cypher,
  /IS_ACTIVE: true/,
  "boolean-declared 'true' renders as an unquoted boolean literal"
);
assert.doesNotMatch(
  boolTrue.cypher,
  /IS_ACTIVE: 'true'/,
  "boolean-declared 'true' must not render as a quoted string"
);
assert.match(
  boolTrue.cypher,
  /NAME: 'true'/,
  "string-declared 'true' still renders as a quoted string"
);

const boolFalse = composer.composeQuery(
  createQuery({
    key: "IS_ACTIVE",
    value: "FALSE",
    schematic_properties: { value_type: "boolean" },
  })
);
assert.match(
  boolFalse.cypher,
  /IS_ACTIVE: false/,
  "boolean-declared 'FALSE' renders as false (case-insensitive)"
);

const unrecognized = composer.composeQuery(
  createQuery({
    key: "IS_ACTIVE",
    value: "maybe",
    schematic_properties: { value_type: "boolean" },
  })
);
assert.match(
  unrecognized.cypher,
  /IS_ACTIVE: 'maybe'/,
  "unrecognized boolean text passes through as a quoted string"
);

console.log("composer-boolean-literal: ok");
