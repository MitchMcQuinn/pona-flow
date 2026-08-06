/**
 * Graph-based match builder: projection <-> serialization parity and structural edits.
 *
 * Verifies that projecting a clause to a graph and re-serializing it produces Cypher
 * identical to the original (linear path, self-loop, branch, cycle), and that the
 * structural ops (addGraphEdge / removeGraphNode / removeGraphEdge) yield valid,
 * composable patterns — including arbitrary (middle) node removal.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import {
  projectMatchToGraph,
  serializeMatchGraph,
  addGraphEdge,
  removeGraphNode,
  removeGraphEdge
} from "../App/ui/src/state/builder/matchGraph.ts";

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

function rel(variable, attributiveLabel) {
  return {
    kind: "relationship",
    relationship: {
      variable,
      alias_mode: "define",
      alias_locked: true,
      attributive_label: attributiveLabel,
      type: "POINTS_TO",
      properties: []
    }
  };
}

function query(patterns) {
  return {
    id: "q1",
    name: "",
    operation: "read",
    parameters: [],
    match: [{ label: "STEP", optional: false, patterns }],
    return: { distinct: false, items: [] }
  };
}

function reserialize(q) {
  const graph = projectMatchToGraph(q, 0);
  const clause = serializeMatchGraph(graph, q.match[0]);
  return { ...q, match: [clause] };
}

function cypherOf(q) {
  return composer.composeQuery(q).cypher;
}

function assertRoundTripParity(name, q) {
  const before = cypherOf(q);
  const after = cypherOf(reserialize(q));
  assert.equal(after, before, `${name}: re-serialized cypher should match original\n  before: ${before}\n  after:  ${after}`);
}

// --- 1. Round-trip parity: linear path A -> B -> C ---
assertRoundTripParity(
  "linear",
  query([
    {
      path: [
        defineNode("a", "A"),
        rel("r1", "R1"),
        defineNode("b", "B"),
        rel("r2", "R2"),
        defineNode("c", "C")
      ]
    }
  ])
);

// --- 2. Round-trip parity: self-loop A -> A ---
assertRoundTripParity(
  "self-loop",
  query([{ path: [defineNode("a", "A"), rel("r1", "R1"), refNode("a", "A")] }])
);

// --- 3. Round-trip parity: branch (two patterns sharing A) ---
assertRoundTripParity(
  "branch",
  query([
    { path: [defineNode("a", "A"), rel("r1", "R1"), defineNode("b", "B")] },
    { path: [refNode("a", "A"), rel("r2", "R2"), defineNode("c", "C")] }
  ])
);

// --- 4. Round-trip parity: cycle A -> B -> C -> A ---
assertRoundTripParity(
  "cycle",
  query([
    {
      path: [
        defineNode("a", "A"),
        rel("r1", "R1"),
        defineNode("b", "B"),
        rel("r2", "R2"),
        defineNode("c", "C"),
        rel("r3", "R3"),
        refNode("a", "A")
      ]
    }
  ])
);

// --- 5. addGraphEdge to a new target appends a hop ---
{
  const q = query([{ path: [defineNode("a", "A")] }]);
  const next = addGraphEdge(0, "a", { kind: "new" })(q);
  const path = next.match[0].patterns[0].path;
  assert.equal(path.length, 3, "new-target add should produce node-rel-node");
  assert.equal(path[0].node.variable, "a");
  assert.equal(path[1].kind, "relationship");
  assert.equal(path[2].kind, "node");
  assert.notEqual(path[2].node.variable, "a", "new target is a distinct node");
  assert.equal(path[2].node.alias_mode, "define");
}

// --- 6. addGraphEdge to the same node creates a self-loop (implicit alias) ---
{
  const q = query([{ path: [defineNode("a", "A")] }]);
  const next = addGraphEdge(0, "a", { kind: "existing", variable: "a" })(q);
  const path = next.match[0].patterns[0].path;
  assert.equal(path.length, 3, "self-loop should be node-rel-node");
  assert.equal(path[0].node.variable, "a");
  assert.equal(path[0].node.alias_mode, "define");
  assert.equal(path[2].node.variable, "a");
  assert.equal(path[2].node.alias_mode, "reference", "self-loop target references the source");
  const cy = cypherOf(next);
  assert.match(cy, /\(a:STEP[^)]*\)-\[[^\]]+\]->\(a\)/, `self-loop cypher: ${cy}`);
}

// --- 7. addGraphEdge off a node that already has an edge becomes a branch ---
{
  const q = query([{ path: [defineNode("a", "A"), rel("r1", "R1"), defineNode("b", "B")] }]);
  const next = addGraphEdge(0, "a", { kind: "new" })(q);
  const patterns = next.match[0].patterns;
  assert.equal(patterns.length, 2, "second edge off A should split into two patterns");
  assert.equal(patterns[0].path[0].node.variable, "a");
  assert.equal(patterns[0].path[0].node.alias_mode, "define");
  assert.equal(patterns[1].path[0].node.variable, "a");
  assert.equal(patterns[1].path[0].node.alias_mode, "reference", "branch reuses A by reference");
}

// --- 8. removeGraphNode on a middle node splits the path ---
{
  const q = query([
    {
      path: [
        defineNode("a", "A"),
        rel("r1", "R1"),
        defineNode("b", "B"),
        rel("r2", "R2"),
        defineNode("c", "C")
      ]
    }
  ]);
  const next = removeGraphNode(0, "b")(q);
  const patterns = next.match[0].patterns;
  const variables = patterns.flatMap((p) => p.path.map((el) => el.node?.variable)).filter(Boolean);
  assert.ok(!variables.includes("b"), "B should be gone");
  assert.deepEqual(variables.sort(), ["a", "c"], "A and C remain");
  // No edges remain (both were incident to B); each survivor is a standalone node.
  patterns.forEach((p) => assert.equal(p.path.length, 1, "survivors are single-node patterns"));
  // Still composes without throwing.
  assert.ok(typeof cypherOf(next) === "string");
}

// --- 9. removeGraphEdge keeps both endpoint nodes ---
{
  const q = query([{ path: [defineNode("a", "A"), rel("r1", "R1"), defineNode("b", "B")] }]);
  const next = removeGraphEdge(0, "r1")(q);
  const patterns = next.match[0].patterns;
  const variables = patterns.flatMap((p) => p.path.map((el) => el.node?.variable)).filter(Boolean);
  assert.deepEqual(variables.sort(), ["a", "b"], "both endpoints kept after edge removal");
  patterns.forEach((p) => assert.equal(p.path.length, 1));
}

// --- 10. removing the last node leaves a non-empty clause ---
{
  const q = query([{ path: [defineNode("a", "A")] }]);
  const next = removeGraphNode(0, "a")(q);
  assert.equal(next.match[0].patterns.length, 1, "clause keeps one pattern");
  assert.equal(next.match[0].patterns[0].path.length, 1, "with one fresh node");
}

// --- 11. projection groups occurrences by variable ---
{
  const q = query([
    { path: [defineNode("a", "A"), rel("r1", "R1"), defineNode("b", "B")] },
    { path: [refNode("a", "A"), rel("r2", "R2"), defineNode("c", "C")] }
  ]);
  const graph = projectMatchToGraph(q, 0);
  assert.equal(graph.nodes.length, 3, "a, b, c are distinct graph nodes");
  assert.equal(graph.edges.length, 2, "r1 and r2 are edges");
  const a = graph.nodes.find((n) => n.variable === "a");
  assert.equal(a.attributiveLabel, "A");
  // 'a' is defined in pattern 0 (not the reference in pattern 1).
  assert.equal(a.address.patternIndex, 0);
}

console.log("matchgraph-serialize: ok");
