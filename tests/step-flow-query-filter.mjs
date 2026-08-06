/**
 * Diagnostic: step-flow API filters graph by selected query_id.
 * Run: node tests/step-flow-query-filter.mjs
 * Requires dev_server on http://127.0.0.1:8765
 */

const BASE = "http://127.0.0.1:8765";
const SPACE = "primary";

async function fetchStepFlow(queryId) {
  const url = new URL("/api/graph/step-flow", BASE);
  url.searchParams.set("space_id", SPACE);
  if (queryId) url.searchParams.set("query_id", queryId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function labels(graph) {
  return (graph.step_graph?.nodes ?? []).map((n) => n.attributive_label).sort();
}

const full = await fetchStepFlow(null);
const superStep = await fetchStepFlow("query-mprj1v2z-2");
const poo = await fetchStepFlow("query-mprpackv-2");

console.log("full graph nodes:", labels(full).join(", "));
console.log("super step test nodes:", labels(superStep).join(", "));
console.log("poo nodes:", labels(poo).join(", "));

if (labels(full).length <= labels(superStep).length) {
  throw new Error("expected full graph to be larger than a single-sequence graph");
}
if (!labels(superStep).includes("SUPER_STEP")) {
  throw new Error("super step test should include SUPER_STEP");
}
if (labels(superStep).includes("POO")) {
  throw new Error("super step test should not include unrelated POO");
}
if (!labels(poo).includes("POO")) {
  throw new Error("poo sequence should include POO");
}

console.log("step-flow query filter OK");
