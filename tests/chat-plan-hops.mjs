/**
 * A flat operation payload with hops becomes the same-kind path the builder compiles.
 * A link matches two existing nodes and creates the relationship. A read walks that
 * relationship. A seed create mints the anchor, the relationship, and the new target.
 */

import assert from "node:assert/strict";

import { buildOperationQuery, mintedIdCount, previewChatIntent } from "../App/authoring/src/index.ts";

function pathOf(preview) {
  return preview.query.match[0].patterns[0].path;
}

const link = previewChatIntent({
  kind: "upsert_query",
  summary: "Link nurse to unit",
  payload: {
    name: "link_nurse_unit",
    kind: "operation",
    operation: "create",
    node_label: "SCHEMA",
    attributive_label: "nurse",
    anchor_source: "existing",
    add_as_sequence: false,
    hops: [
      { relationship_label: "nurse_unit", target_label: "unit", target_source: "existing" },
    ],
  },
});
const linkPath = pathOf(link);
assert.equal(linkPath.length, 3);
assert.equal(linkPath[0].node.node_source, "existing");
assert.equal(linkPath[0].node.id_binding, undefined);
assert.equal(linkPath[1].relationship.attributive_label, "nurse_unit");
assert.equal(linkPath[1].relationship.type, "POINTS_TO");
assert.equal(linkPath[1].relationship.node_source, "new");
assert.equal(linkPath[1].relationship.id_binding.value, "preview-entity");
assert.equal(linkPath[2].node.attributive_label, "unit");
assert.equal(linkPath[2].node.node_source, "existing");
assert.equal(linkPath[2].node.id_binding, undefined);

const read = previewChatIntent({
  kind: "upsert_query",
  summary: "Load nurse",
  payload: {
    name: "read_nurse",
    kind: "operation",
    operation: "read",
    node_label: "INSTANCE",
    attributive_label: "nurse",
    return_items: [{ expression: "n.name", alias: "subject" }],
    hops: [
      { relationship_label: "nurse_unit", target_label: "unit", target_source: "existing" },
    ],
  },
});
const readPath = pathOf(read);
assert.equal(readPath[1].relationship.node_source, "existing");
assert.equal(readPath[1].relationship.id_binding, undefined);
assert.equal(readPath[2].node.node_source, "existing");
assert.equal(readPath[2].node.attributive_label, "unit");
assert.equal(read.query.return.items[0].alias, "subject");

const seed = {
  name: "seed_nurse",
  operation: "create",
  node_label: "INSTANCE",
  attributive_label: "nurse",
  instance_properties: [{ key: "name", value: "Example" }],
  hops: [
    {
      relationship_label: "nurse_unit",
      target_label: "unit",
      target_source: "new",
      instance_properties: [{ key: "name", value: "Related" }],
    },
  ],
};
assert.equal(mintedIdCount(seed), 3);
assert.equal(
  mintedIdCount({
    operation: "create",
    anchor_source: "existing",
    hops: [{ relationship_label: "nurse_unit", target_label: "unit", target_source: "existing" }],
  }),
  1
);
assert.equal(mintedIdCount({ operation: "read", hops: seed.hops }), 0);

const compiled = buildOperationQuery(seed, {
  queryId: "seed",
  entityIds: ["anchor", "relationship", "target"],
});
const seedPath = compiled.match[0].patterns[0].path;
assert.equal(seedPath[0].node.id_binding.value, "anchor");
assert.equal(seedPath[1].relationship.id_binding.value, "relationship");
assert.equal(seedPath[2].node.id_binding.value, "target");
assert.equal(seedPath[2].node.node_source, "new");
assert.equal(seedPath[2].node.properties.some((property) => property.value === "Related"), true);

console.log("chat-plan hops ok");
