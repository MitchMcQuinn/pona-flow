/**
 * Graph-based match builder: the drawn arrowhead follows the hop's direction.
 *
 * A reverse hop composes as `(from)<-[rel]-(to)`, so the canvas must draw it to -> from
 * and land the arrowhead on `from`. This pins `edgeDrawOrder` to the composer: whichever
 * node the Cypher arrow points at is the node the drawn segment ends on.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { edgeDrawOrder, projectMatchToGraph } from "../App/ui/src/state/builder/matchGraph.ts";

function defineNode(variable, attributiveLabel) {
  return {
    kind: "node",
    node: {
      variable,
      alias_mode: "define",
      alias_locked: true,
      attributive_label: attributiveLabel,
      properties: []
    }
  };
}

function refNode(variable, attributiveLabel) {
  return {
    kind: "node",
    node: {
      variable,
      alias_mode: "reference",
      alias_ref: variable,
      attributive_label: attributiveLabel,
      properties: []
    }
  };
}

function rel(variable, attributiveLabel, direction) {
  return {
    kind: "relationship",
    relationship: {
      variable,
      alias_mode: "define",
      alias_locked: true,
      attributive_label: attributiveLabel,
      type: "POINTS_TO",
      properties: [],
      ...(direction ? { direction } : {})
    }
  };
}

function query(path) {
  return {
    id: "q1",
    name: "",
    operation: "read",
    parameters: [],
    match: [{ label: "INSTANCE", optional: false, patterns: [{ path }] }],
    return: { distinct: false, items: [] }
  };
}

function onlyEdge(q) {
  const graph = projectMatchToGraph(q, 0);
  assert.equal(graph.edges.length, 1, "fixture should project exactly one edge");
  return graph.edges[0];
}

// --- 1. An outgoing hop draws in path order; the arrow lands on the trailing node ---
{
  const q = query([defineNode("pillar", "PILLAR"), rel("r0", "HAS_MANY", "outgoing"), defineNode("value", "VALUE")]);
  const edge = onlyEdge(q);
  assert.equal(edge.direction, "outgoing");
  assert.deepEqual(edgeDrawOrder(edge), { source: "pillar", target: "value" });

  const cypher = composer.composeQuery(q).cypher;
  assert.match(cypher, /\(pillar[^)]*\)-\[r0[^\]]*\]->\(value/, `outgoing cypher: ${cypher}`);
}

// --- 2. An incoming hop flips the drawn segment so the arrow lands on the leading node ---
{
  const q = query([defineNode("value", "VALUE"), rel("r0", "HAS_MANY", "incoming"), defineNode("pillar", "PILLAR")]);
  const edge = onlyEdge(q);
  assert.equal(edge.direction, "incoming");
  // Path order is unchanged — only the drawing order flips.
  assert.equal(edge.from, "value");
  assert.equal(edge.to, "pillar");
  assert.deepEqual(
    edgeDrawOrder(edge),
    { source: "pillar", target: "value" },
    "reverse hop draws pillar -> value so the head sits on value"
  );

  const cypher = composer.composeQuery(q).cypher;
  assert.match(cypher, /\(value[^)]*\)<-\[r0[^\]]*\]-\(pillar/, `incoming cypher: ${cypher}`);
}

// --- 3. A missing direction is treated as outgoing (the projection default) ---
{
  const q = query([defineNode("a", "A"), rel("r0", "R0"), defineNode("b", "B")]);
  const edge = onlyEdge(q);
  assert.equal(edge.direction, "outgoing", "absent direction projects as outgoing");
  assert.deepEqual(edgeDrawOrder(edge), { source: "a", target: "b" });
}

// --- 4. The drawn target always matches the node the composed arrow points at ---
for (const direction of ["outgoing", "incoming"]) {
  const q = query([defineNode("a", "A"), rel("r0", "R0", direction), defineNode("b", "B")]);
  const edge = onlyEdge(q);
  const cypher = composer.composeQuery(q).cypher;
  // `<-[` means the arrow points back at the node preceding the relationship.
  const cypherArrowTarget = cypher.includes("<-[r0") ? "a" : "b";
  assert.equal(
    edgeDrawOrder(edge).target,
    cypherArrowTarget,
    `${direction}: drawn arrowhead should sit on the node the Cypher arrow points at\n  ${cypher}`
  );
}

// --- 5. Self-loops keep both ends on one node; direction still selects the arc's head end ---
for (const direction of ["outgoing", "incoming"]) {
  const q = query([defineNode("a", "A"), rel("r0", "R0", direction), refNode("a", "A")]);
  const edge = onlyEdge(q);
  const order = edgeDrawOrder(edge);
  assert.equal(order.source, "a");
  assert.equal(order.target, "a", "a self-loop cannot be redrawn end-to-end");
  assert.equal(edge.direction, direction, "direction survives projection so the canvas can flip the marker");
}

console.log("matchgraph-edge-direction: ok");
