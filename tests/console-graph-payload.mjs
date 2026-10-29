/**
 * Console graph module: sequence graph results and the short node/edge form
 * both normalize to the payload the builder canvas draws.
 *
 * Run from App/ui: `npx tsx ../../tests/console-graph-payload.mjs`
 */
import assert from "node:assert/strict";
import { graphPayloadFromModuleData } from "../App/ui/src/consoles/modules/graphPayload.ts";

const sequence = graphPayloadFromModuleData({
  kind: "graph",
  columns: ["n"],
  rows: [],
  graph: {
    nodes: [
      {
        element_id: "4:a",
        labels: ["INSTANCE"],
        properties: { id: "1042", attributive_label: "order" },
        display_label: "1042",
      },
      {
        element_id: "4:b",
        labels: ["SCHEMA"],
        properties: { attributive_label: "order" },
      },
    ],
    relationships: [
      {
        element_id: "5:r",
        type: "INSTANCE_OF",
        start: "4:a",
        end: "4:b",
        properties: { attributive_label: "of" },
      },
    ],
  },
});
assert.equal(sequence.nodes.length, 2);
assert.equal(sequence.nodes[0].display_label, "1042");
assert.equal(sequence.nodes[0].labels[0], "INSTANCE");
assert.equal(sequence.nodes[1].display_label, undefined);
assert.equal(sequence.nodes[1].properties.attributive_label, "order");
assert.equal(sequence.relationships[0].type, "INSTANCE_OF");
assert.equal(sequence.relationships[0].start, "4:a");
assert.equal(sequence.relationships[0].properties.attributive_label, "of");

const simple = graphPayloadFromModuleData({
  nodes: [
    { id: "a", label: "Order" },
    { id: 2, label: "Lane" },
  ],
  edges: [{ source: "a", target: 2, type: "AT", label: "docked" }],
});
assert.equal(simple.nodes[0].element_id, "a");
assert.equal(simple.nodes[0].display_label, "Order");
assert.deepEqual(simple.nodes[0].labels, ["NODE"]);
assert.equal(simple.nodes[1].element_id, "2");
assert.equal(simple.relationships[0].end, "2");
assert.equal(simple.relationships[0].type, "AT");
assert.equal(simple.relationships[0].properties.attributive_label, "docked");

const fromTo = graphPayloadFromModuleData({
  nodes: [
    { id: "a", name: "Pack" },
    { id: "b", attributive_label: "ship", labels: ["STEP"] },
  ],
  relationships: [{ from: "a", to: "b", label: "NEXT" }],
});
assert.equal(fromTo.nodes[0].display_label, "Pack");
assert.deepEqual(fromTo.nodes[1].labels, ["STEP"]);
assert.equal(fromTo.nodes[1].display_label, "ship");
assert.equal(fromTo.relationships[0].element_id, "rel-0");
assert.equal(fromTo.relationships[0].type, "NEXT");
assert.equal(fromTo.relationships[0].properties.attributive_label, undefined);

const empty = graphPayloadFromModuleData({ nodes: [], relationships: [] });
assert.deepEqual(empty, { nodes: [], relationships: [] });

const dangling = graphPayloadFromModuleData({
  nodes: [{ element_id: "n", labels: ["NODE"], properties: {} }],
  relationships: [{ element_id: "r", type: "X", start: null, end: null, properties: {} }],
});
assert.equal(dangling.nodes.length, 1);
assert.equal(dangling.relationships.length, 0);

const duplicate = graphPayloadFromModuleData({
  nodes: [
    { id: "a", label: "One" },
    { id: "a", label: "Two" },
  ],
  relationships: [
    { id: "e", source: "a", target: "a", type: "LOOP" },
    { id: "e", source: "a", target: "a", type: "AGAIN" },
  ],
});
assert.equal(duplicate.nodes.length, 1);
assert.equal(duplicate.nodes[0].display_label, "One");
assert.equal(duplicate.relationships.length, 1);
assert.equal(duplicate.relationships[0].type, "LOOP");

assert.equal(graphPayloadFromModuleData({ kind: "table", columns: [], rows: [] }), null);
assert.equal(graphPayloadFromModuleData({ kind: "response", response: "{}" }), null);
assert.equal(graphPayloadFromModuleData({ nodes: [{ label: "no id" }] }), null);
assert.equal(graphPayloadFromModuleData({ nodes: [], relationships: ["nope"] }), null);
assert.equal(graphPayloadFromModuleData([{ id: "a" }]), null);
assert.equal(graphPayloadFromModuleData(null), null);

console.log("console-graph-payload: ok");
