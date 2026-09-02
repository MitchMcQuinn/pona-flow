/**
 * UNWIND authoring: validation, parameter discovery, and unwindItemPatch.
 *
 * Run from App/ui: `npx tsx ../../tests/unwind-authoring.mjs`
 */
import assert from "node:assert/strict";
import {
  collectReadMatchPathBindings,
  collectReferencedParameterNames,
  unwindItemPatch,
  validateQuery
} from "../App/authoring/src/index.ts";

function twoEntityRead(extra = {}) {
  return {
    id: "q1",
    name: "stack-ids",
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
                node: { variable: "subject", attributive_label: "ENTITY", properties: [] }
              },
              {
                kind: "relationship",
                relationship: {
                  variable: "r0",
                  attributive_label: "PREDICATE",
                  type: "POINTS_TO",
                  properties: []
                }
              },
              {
                kind: "node",
                node: { variable: "object", attributive_label: "ENTITY", properties: [] }
              }
            ]
          }
        ]
      }
    ],
    return: { distinct: false, items: [] },
    ...extra
  };
}

const bindings = collectReadMatchPathBindings(twoEntityRead());
assert.equal(bindings.filter((b) => b.entityRole === "node").length, 2);

const subjectId = unwindItemPatch(bindings, "subject", "id");
assert.equal(subjectId.expression, "subject.id");
assert.equal(subjectId.path_variable, "subject");
assert.equal(subjectId.property_key, "id");

const complete = twoEntityRead({
  unwind: {
    alias: "entityId",
    items: [
      unwindItemPatch(bindings, "subject", "id"),
      unwindItemPatch(bindings, "object", "id")
    ]
  }
});
assert.deepEqual(validateQuery(complete, false), []);

const oneValue = validateQuery(
  twoEntityRead({
    unwind: { alias: "entityId", items: [{ expression: "subject.id" }] }
  }),
  false
);
assert.ok(
  oneValue.some((w) => w.includes("at least two values")),
  `expected two-value warning, got ${oneValue.join("; ")}`
);

const missingAlias = validateQuery(
  twoEntityRead({
    unwind: {
      alias: "",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    }
  }),
  false
);
assert.ok(
  missingAlias.some((w) => w.includes("needs an alias")),
  `expected alias warning, got ${missingAlias.join("; ")}`
);

const badAlias = validateQuery(
  twoEntityRead({
    unwind: {
      alias: "1bad",
      items: [{ expression: "subject.id" }, { expression: "object.id" }]
    }
  }),
  false
);
assert.ok(
  badAlias.some((w) => w.startsWith("UNWIND alias:")),
  `expected alias format warning, got ${badAlias.join("; ")}`
);

const onUpdate = validateQuery(
  {
    ...twoEntityRead({
      unwind: {
        alias: "entityId",
        items: [{ expression: "subject.id" }, { expression: "object.id" }]
      }
    }),
    operation: "update",
    set: [{ expression: "subject.x = 1" }],
    return: undefined
  },
  false
);
assert.ok(
  onUpdate.some((w) => w.includes("only used on read")),
  `expected read-only warning, got ${onUpdate.join("; ")}`
);

const withParam = twoEntityRead({
  unwind: {
    alias: "entityId",
    items: [
      { expression: "subject.id" },
      { expression: "$otherId", path_variable: "object", property_key: "$otherId" }
    ]
  }
});
assert.deepEqual(collectReferencedParameterNames(withParam), ["otherId"]);

console.log("unwind-authoring: ok");
