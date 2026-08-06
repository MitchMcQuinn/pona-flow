/**
 * Read STEP/SCHEMA single-node traversal: read_traversal composes a named-path
 * variable-length query (downstream directed, network undirected) returning path.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

function singleNodeQuery(label, attributiveLabel, mode, extra = {}) {
  return {
    id: "q-traversal",
    name: "traversal",
    operation: "read",
    match: [
      {
        label,
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: { variable: "n1", attributive_label: attributiveLabel, properties: [] }
              }
            ]
          }
        ]
      }
    ],
    parameters: [],
    return: { distinct: false, items: [] },
    read_traversal: mode,
    ...extra
  };
}

// downstream: directed variable-length path, RETURN path.
const downstream = composer.composeQuery(singleNodeQuery("STEP", "Order placed", "downstream"));
assert.equal(
  downstream.cypher,
  "MATCH path = (:STEP { attributive_label: 'Order placed' })-[*]->(downstream)\nRETURN path"
);

// network: undirected variable-length path.
const network = composer.composeQuery(singleNodeQuery("SCHEMA", "Company", "network"));
assert.equal(
  network.cypher,
  "MATCH path = (:SCHEMA { attributive_label: 'Company' })-[*]-(connected)\nRETURN path"
);

// attributive_label parameter renders unquoted and registers as a parameter.
const paramQuery = singleNodeQuery("STEP", "$companyType", "downstream", {
  parameters: [{ name: "companyType", data_type: "string", value: "Acme" }]
});
const withParam = composer.composeQuery(paramQuery);
assert.match(withParam.cypher, /attributive_label: \$companyType/);
assert.doesNotMatch(withParam.cypher, /attributive_label: '\$companyType'/);
assert.equal(withParam.parameters.companyType, "Acme");

// More than one node: traversal is ignored, falls back to normal read.
const twoNodes = {
  ...singleNodeQuery("STEP", "A", "downstream"),
  match: [
    {
      label: "STEP",
      patterns: [
        {
          path: [
            { kind: "node", node: { variable: "n1", attributive_label: "A", properties: [] } },
            {
              kind: "relationship",
              relationship: { variable: "r1", type: "POINTS_TO", direction: "outgoing", properties: [] }
            },
            { kind: "node", node: { variable: "n2", attributive_label: "B", properties: [] } }
          ]
        }
      ]
    }
  ]
};
const fallback = composer.composeQuery(twoNodes);
assert.doesNotMatch(fallback.cypher, /RETURN path/);
assert.match(fallback.cypher, /RETURN \*/);

// INSTANCE single node: traversal not applicable (only STEP/SCHEMA).
const instance = composer.composeQuery(singleNodeQuery("INSTANCE", "Order", "downstream"));
assert.doesNotMatch(instance.cypher, /RETURN path/);

// Unconstrained single node (no attributive_label, no traversal): network default.
const bareStep = composer.composeQuery(singleNodeQuery("STEP", "", undefined));
assert.equal(bareStep.cypher, "MATCH (n:STEP)-[r*]-(n)\nRETURN *");

const bareInstance = composer.composeQuery(singleNodeQuery("INSTANCE", "", undefined));
assert.equal(bareInstance.cypher, "MATCH (n:INSTANCE)-[r*]-(n)\nRETURN *");

// A constrained node (attributive_label set) keeps the normal single-node match.
const constrained = composer.composeQuery(singleNodeQuery("STEP", "Order placed", undefined));
assert.match(constrained.cypher, /MATCH \(n1:STEP \{ attributive_label: 'Order placed' \}\)/);
assert.doesNotMatch(constrained.cypher, /\[r\*\]/);

// Projections present: not the default network.
const withProjection = composer.composeQuery(
  singleNodeQuery("INSTANCE", "", undefined, {
    return: { distinct: false, items: [{ expression: "n1.name" }] }
  })
);
assert.doesNotMatch(withProjection.cypher, /\[r\*\]/);

console.log("composer-read-traversal: ok");
