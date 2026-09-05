/**
 * The authoring MCP server's tool surface, exercised without a live engine.
 *
 * Everything checked here fails before any HTTP call: the tool schemas build and expose the
 * documented arguments, bad arguments are rejected by the protocol layer, the intent
 * builders produce QueryObjects the composer accepts, and destructive tools refuse to write
 * without a valid confirmation token. Mirrors tests/mcp-gateway-smoke.py, which does the
 * same for the runtime gateway.
 */

import assert from "node:assert/strict";

import { validateQuery } from "../App/authoring/src/index.ts";
import { issueConfirmation, redeemConfirmation, resetConfirmations } from "../App/mcp/src/confirm.ts";
import {
  buildOperationQuery,
  buildSequenceQuery,
  buildStepTransitionQuery,
  INSTRUCTIONS,
} from "../App/mcp/src/index.ts";
import { connectTestClient } from "../App/mcp/src/testing.ts";
import composer from "./helpers/composer.mjs";

const config = { apiBase: "http://127.0.0.1:8765", spaceId: "", agentKey: "" };

// --- Tool surface ---

const { client, close } = await connectTestClient(config);

const { tools } = await client.listTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));

const expected = [
  "list_spaces",
  "describe_space",
  "list_operations",
  "get_operation",
  "describe_sequence",
  "list_step_nodes",
  "list_schemas",
  "describe_schema",
  "create_operation",
  "update_operation",
  "create_step_transition",
  "create_sequence",
  "update_sequence",
  "delete_operation",
  "delete_step",
  "delete_schema",
  "repair_step_wraps",
];
for (const name of expected) {
  assert.ok(byName.has(name), `tool ${name} must be registered`);
  const tool = byName.get(name);
  assert.equal(tool.inputSchema.type, "object", `${name} must expose an object input schema`);
  assert.ok(
    (tool.description || "").length > 40,
    `${name} needs a description an agent can act on`
  );
}
assert.equal(tools.length, expected.length, "no undocumented tools");

// Every read-only tool says so, and every cascading delete is flagged destructive.
for (const name of ["list_spaces", "describe_space", "list_operations", "get_operation"]) {
  assert.equal(byName.get(name).annotations?.readOnlyHint, true, `${name} is read-only`);
}
for (const name of ["delete_step", "delete_schema", "delete_operation"]) {
  assert.equal(byName.get(name).annotations?.destructiveHint, true, `${name} is destructive`);
  assert.ok(
    "confirm_token" in byName.get(name).inputSchema.properties,
    `${name} must take a confirm_token`
  );
}

// The intent arguments are the primary interface; the raw QueryObject is the escape hatch.
const createSchema = byName.get("create_operation").inputSchema;
for (const arg of ["name", "operation", "node_label", "attributive_label", "query"]) {
  assert.ok(arg in createSchema.properties, `create_operation must accept ${arg}`);
}
assert.deepEqual(
  createSchema.required.sort(),
  ["name", "node_label", "operation"],
  "only the arguments with no sensible default are required"
);
assert.ok("http_step" in createSchema.properties, "create_operation accepts http_step");
assert.ok("unwind" in createSchema.properties, "create_operation accepts unwind");
assert.ok(
  "local_llm_step" in createSchema.properties,
  "create_operation accepts local_llm_step"
);
assert.equal(
  "code_step" in createSchema.properties,
  false,
  "code-execution STEPs are archived; create_operation must not accept code_step"
);

assert.ok("add_as_sequence" in createSchema.properties, "create_operation accepts add_as_sequence");
assert.equal(
  (createSchema.required || []).includes("add_as_sequence"),
  false,
  "add_as_sequence defaults to true; agents may pass false"
);

const updateOperationSchema = byName.get("update_operation").inputSchema;
assert.ok("name" in updateOperationSchema.properties, "update_operation must accept a workspace title");

const updateSequenceSchema = byName.get("update_sequence").inputSchema;
assert.ok(
  "name" in updateSequenceSchema.properties,
  "update_sequence must accept a workspace title"
);

// --- Argument validation happens before anything reaches the network ---

const missingName = await client.callTool({
  name: "create_operation",
  arguments: { operation: "create", node_label: "SCHEMA" },
});
assert.equal(missingName.isError, true, "a missing required argument is rejected");

const badEnum = await client.callTool({
  name: "create_operation",
  arguments: { name: "X", operation: "upsert", node_label: "SCHEMA" },
});
assert.equal(badEnum.isError, true, "an out-of-range operation is rejected");

// With no space configured and none passed, tools fail with an actionable message rather
// than defaulting to some arbitrary space.
const noSpace = await client.callTool({ name: "describe_space", arguments: {} });
assert.equal(noSpace.isError, true);
assert.match(JSON.parse(noSpace.content[0].text).error, /list_spaces/);

await close();

// --- The build order an agent must follow is stated up front ---

assert.match(INSTRUCTIONS, /create_operation/);
assert.match(INSTRUCTIONS, /create_step_transition/);
assert.match(INSTRUCTIONS, /create_sequence/);
assert.ok(
  INSTRUCTIONS.indexOf("1. create_operation") < INSTRUCTIONS.indexOf("3. create_sequence"),
  "the instructions must present the stages in dependency order"
);
assert.match(INSTRUCTIONS, /HTTP call, or a Local LLM call/);
assert.match(
  INSTRUCTIONS,
  /default to NEXT/,
  "instructions must say STEP-to-STEP edges may reuse NEXT"
);
assert.equal(
  /code_step|code-execution|sandboxed code/i.test(INSTRUCTIONS),
  false,
  "authoring MCP instructions must not advertise code-execution STEPs"
);

const transitionSchema = byName.get("create_step_transition").inputSchema;
assert.ok("relationship_label" in transitionSchema.properties);
assert.equal(
  (transitionSchema.required || []).includes("relationship_label"),
  false,
  "STEP-to-STEP edges default to NEXT; a unique relationship_label is not required"
);

// --- Intent -> QueryObject -> Cypher ---

const schemaQuery = buildOperationQuery(
  {
    name: "Create customer",
    operation: "create",
    node_label: "SCHEMA",
    attributive_label: "customer record",
    schema_properties: [
      { key: "email address", value_type: "string", format: "email", is_required: true, is_key: true },
      { key: "name", is_label: true },
    ],
  },
  { queryId: "q1", entityIds: ["ent-1"] }
);
assert.deepEqual(validateQuery(schemaQuery, true), [], "intent output must pass validation");
assert.equal(
  schemaQuery.match[0].patterns[0].path[0].node.attributive_label,
  "CUSTOMER_RECORD",
  "a free-text label is normalized to UPPER_SNAKE rather than rejected"
);
assert.deepEqual(
  schemaQuery.match[0].patterns[0].path[0].node.properties.map((p) => p.key),
  ["EMAIL_ADDRESS", "NAME"],
  "property keys are normalized the same way the builder normalizes them as you type"
);
const schemaCypher = composer.composeQuery(schemaQuery).cypher;
assert.match(schemaCypher, /MERGE \(CUSTOMER_RECORD:SCHEMA \{[^}]*id: 'ent-1'/);

const readQuery = buildOperationQuery(
  {
    name: "Find customer",
    operation: "read",
    node_label: "INSTANCE",
    attributive_label: "CUSTOMER_RECORD",
    where: [{ property_key: "EMAIL_ADDRESS", operator: "=", value: "$email" }],
    return_items: [{ expression: "CUSTOMER_RECORD.NAME", alias: "name" }],
    parameters: [{ name: "email", is_required: true }],
    limit: 10,
  },
  { queryId: "q2", entityIds: [] }
);
const readCypher = composer.composeQuery(readQuery).cypher;
assert.match(readCypher, /MATCH/);
assert.match(readCypher, /\$email/);
assert.match(readCypher, /LIMIT 10/);

const unwindQuery = buildOperationQuery(
  {
    name: "Stack statement ends",
    operation: "read",
    node_label: "INSTANCE",
    attributive_label: "ENTITY",
    unwind: { alias: "entityId", expressions: ["SUBJECT.id", "OBJECT.id"] },
  },
  { queryId: "q2b", entityIds: [] }
);
assert.equal(unwindQuery.unwind.alias, "entityId");
assert.equal(unwindQuery.unwind.items.length, 2);
const unwindCypher = composer.composeQuery(unwindQuery).cypher;
assert.match(unwindCypher, /UNWIND \[SUBJECT\.id, OBJECT\.id\] AS entityId/);
assert.match(unwindCypher, /RETURN entityId/);

// A transition MATCHes both endpoints by graph id, then MERGEs the edge between them —
// this is what stops it from creating two empty STEP nodes instead of wiring the real ones.
const transition = buildStepTransitionQuery(
  {
    from: { id: "step-a", attributive_label: "STEP_A" },
    to: { id: "step-b", attributive_label: "STEP_B" },
    relationship_label: "on approval",
    condition_type: "parameter",
    condition: "$approved",
    condition_expected: true,
  },
  { queryId: "q3", entityIds: ["rel-1"] }
);
assert.deepEqual(validateQuery(transition, false), []);
const transitionCypher = composer.composeQuery(transition).cypher;
assert.match(transitionCypher, /MATCH \(STEP_A:STEP \{ id: 'step-a' \}\)/);
assert.match(transitionCypher, /MATCH \(STEP_B:STEP \{ id: 'step-b' \}\)/);
assert.match(transitionCypher, /MERGE \(STEP_A\)-\[ON_APPROVAL:POINTS_TO \{[^}]*id: 'rel-1'/);
assert.doesNotMatch(
  transitionCypher,
  /MERGE \(STEP_A:STEP/,
  "existing endpoints must be matched, never re-created"
);

// A multi-step sequence has to traverse; a single-step one must not, or it would swallow
// the chain of any longer sequence sharing its entry step.
const downstream = composer.composeQuery(
  buildSequenceQuery({ id: "seq-1", entry_step: "STEP_A" })
).cypher;
assert.match(downstream, /MATCH path = \(:STEP \{ attributive_label: 'STEP_A' \}\)-\[\*\]->/);

const single = composer.composeQuery(
  buildSequenceQuery({ id: "seq-2", entry_step: "STEP_A", traversal: "single" })
).cypher;
assert.match(single, /MATCH \(STEP_A:STEP \{ attributive_label: 'STEP_A' \}\)/);
assert.doesNotMatch(single, /-\[\*\]/);

// --- Confirmation tokens ---

resetConfirmations();
const token = issueConfirmation("delete_step", "space-1", "STEP_A");
assert.throws(
  () => redeemConfirmation(token, "delete_step", "space-1", "STEP_B"),
  /different target/,
  "a token must not be replayable against another target"
);
assert.throws(
  () => redeemConfirmation(token, "delete_schema", "space-1", "STEP_A"),
  /different target/,
  "a token must not be replayable against another action"
);
assert.throws(() => redeemConfirmation("made-up", "delete_step", "space-1", "STEP_A"), /expired/);
redeemConfirmation(token, "delete_step", "space-1", "STEP_A");
assert.throws(
  () => redeemConfirmation(token, "delete_step", "space-1", "STEP_A"),
  /expired/,
  "a token is single-use"
);

console.log("mcp-authoring-tools: ok");
