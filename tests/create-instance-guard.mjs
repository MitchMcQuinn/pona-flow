/**
 * Create-INSTANCE schema guard: relationship contracts come from outgoing-edge
 * rel_schemata (keyed by preceding node + rel label), not from a same-named SCHEMA
 * node. A branching graph of existing instances + new edges must not false-positive,
 * and a failing cguard must surface in builder warnings so Create operation is not
 * a silent no-op.
 *
 * Run:  npx tsx tests/create-instance-guard.mjs   (tsx lives in App/ui)
 */
import assert from "node:assert/strict";
import {
  CREATE_GUARD_CHECK_KEY,
  createInstanceGuardNodeLabels,
  createInstanceGuardPrecedingLabels,
  summarizeCreateGuardIssues,
  validateCreateInstances
} from "../App/ui/src/state/builder/createInstanceGuard.ts";
import { relSchemaKey } from "../App/ui/src/state/builder/createInstanceSync.ts";
import { schemataConstraintMap } from "../App/ui/src/state/builder/updateInstanceGuard.ts";
import { builderSelectors } from "../App/ui/src/state/builder/selectors.ts";

function schematic(overrides = {}) {
  return {
    key: "NAME",
    value_type: "string",
    format: "any",
    is_required: false,
    is_key: false,
    is_label: false,
    is_indexed: false,
    ...overrides
  };
}

function existingNode(variable, attributiveLabel, idParam, extra = {}) {
  return {
    kind: "node",
    node: {
      variable,
      attributive_label: attributiveLabel,
      node_source: "existing",
      alias_mode: extra.alias_mode ?? "define",
      alias_ref: extra.alias_ref,
      alias_locked: extra.alias_locked,
      id_binding: { key: "id", value: idParam },
      properties: []
    }
  };
}

function newRel(variable, attributiveLabel, properties) {
  return {
    kind: "relationship",
    relationship: {
      variable,
      attributive_label: attributiveLabel,
      alias_mode: "define",
      node_source: "new",
      properties
    }
  };
}

/** The user's branching notebook graph: 4 existing nodes, 5 new edges, 3 MERGE statements. */
function notebookTripleQuery() {
  const notebook = existingNode("n12", "NOTEBOOK", "$notebookId");
  const subject = existingNode("n15", "SUBJECT", "$subjectEntityId");
  const predicate = existingNode("n19", "PREDICATE", "$predicateEntityId");
  const object = existingNode("n23", "OBJECT", "$objectEntityId");
  const has = (variable) =>
    newRel(variable, "HAS_ENTITY_SCHEMA", [
      {
        key: "IS_READ_ONLY",
        value: "false",
        schematic_properties: {
          value_type: "boolean",
          is_required: true,
          is_key: false,
          is_label: false,
          is_indexed: false
        }
      }
    ]);
  return {
    id: "q-triple",
    name: "ADD_TRIPLE",
    operation: "create",
    allow_duplicates: false,
    parameters: [
      { name: "notebookId", value: "", is_required: true },
      { name: "subjectEntityId", value: "", is_required: true },
      { name: "predicateEntityId", value: "", is_required: true },
      { name: "objectEntityId", value: "", is_required: true }
    ],
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              notebook,
              has("r16"),
              subject,
              newRel("r20", "TO_PREDICATE_SCHEMA", []),
              {
                ...predicate,
                node: { ...predicate.node, alias_mode: "define" }
              },
              newRel("r24", "FROM_PREDICATE_SCHEMA", []),
              object
            ]
          },
          {
            path: [
              existingNode("n12", "NOTEBOOK", "$notebookId", {
                alias_mode: "reference",
                alias_ref: "n12",
                alias_locked: true
              }),
              has("r26"),
              existingNode("n19", "PREDICATE", "$predicateEntityId", {
                alias_mode: "reference",
                alias_ref: "n19",
                alias_locked: true
              })
            ]
          },
          {
            path: [
              existingNode("n12", "NOTEBOOK", "$notebookId", {
                alias_mode: "reference",
                alias_ref: "n12",
                alias_locked: true
              }),
              has("r28"),
              existingNode("n23", "OBJECT", "$objectEntityId", {
                alias_mode: "reference",
                alias_ref: "n23",
                alias_locked: true
              })
            ]
          }
        ]
      }
    ]
  };
}

function relConstraintsForNotebook() {
  const map = new Map();
  map.set(
    relSchemaKey("NOTEBOOK", "HAS_ENTITY_SCHEMA"),
    schemataConstraintMap([
      schematic({
        key: "IS_READ_ONLY",
        value_type: "boolean",
        is_required: true
      })
    ])
  );
  map.set(relSchemaKey("SUBJECT", "TO_PREDICATE_SCHEMA"), schemataConstraintMap([]));
  map.set(relSchemaKey("PREDICATE", "FROM_PREDICATE_SCHEMA"), schemataConstraintMap([]));
  return map;
}

function builderState(query, checks = {}) {
  return {
    spaceId: "space-1",
    runtimeEnabled: false,
    query,
    checks,
    run: { status: "idle", error: null, result: null }
  };
}

// --- collectors: existing-node graph contributes parent labels, not node labels ---
{
  const query = notebookTripleQuery();
  assert.deepEqual(createInstanceGuardNodeLabels(query), [], "no new INSTANCE nodes");
  const preceding = createInstanceGuardPrecedingLabels(query).sort();
  assert.deepEqual(
    preceding,
    ["NOTEBOOK", "PREDICATE", "SUBJECT"].sort(),
    "relationship parents include existing/alias-referenced nodes"
  );
}

// --- live outgoing-edge schemata: branching HAS_ENTITY_SCHEMA edges are valid ---
{
  const query = notebookTripleQuery();
  const issues = validateCreateInstances(query, new Map(), relConstraintsForNotebook());
  assert.deepEqual(issues, [], "existing-node + new-edge graph satisfies rel_schemata");
}

// --- false positive the old lookup caused: treating HAS_ENTITY_SCHEMA as a node SCHEMA ---
{
  const query = notebookTripleQuery();
  const nodeStyle = new Map();
  nodeStyle.set(
    "HAS_ENTITY_SCHEMA",
    schemataConstraintMap([
      schematic({ key: "NAME", is_required: true, is_label: true })
    ])
  );
  const issuesIfLookedUpByRelLabel = [];
  const hasConstraints = nodeStyle.get("HAS_ENTITY_SCHEMA");
  for (const [key] of hasConstraints) {
    if (key === "NAME") {
      issuesIfLookedUpByRelLabel.push(
        "HAS_ENTITY_SCHEMA.NAME is required by the schema but missing from this operation."
      );
    }
  }
  assert.ok(issuesIfLookedUpByRelLabel.length, "node-SCHEMA lookup would demand NAME");
  const issues = validateCreateInstances(query, nodeStyle, relConstraintsForNotebook());
  assert.deepEqual(
    issues,
    [],
    "rel_schemata lookup ignores a same-named SCHEMA node's required NAME"
  );
}

// --- missing required relationship property is still flagged ---
{
  const query = notebookTripleQuery();
  query.match[0].patterns[0].path[1].relationship.properties = [];
  const issues = validateCreateInstances(query, new Map(), relConstraintsForNotebook());
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /HAS_ENTITY_SCHEMA\.IS_READ_ONLY is required/);
}

// --- property not on the live edge contract is flagged ---
{
  const query = notebookTripleQuery();
  query.match[0].patterns[0].path[1].relationship.properties.push({
    key: "STALE_FLAG",
    value: "x",
    schematic_properties: {
      value_type: "string",
      is_required: false,
      is_key: false,
      is_label: false,
      is_indexed: false
    }
  });
  const issues = validateCreateInstances(query, new Map(), relConstraintsForNotebook());
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /STALE_FLAG: property no longer exists/);
}

// --- new node still validates against node SCHEMA constraints ---
{
  const query = {
    operation: "create",
    match: [
      {
        label: "INSTANCE",
        patterns: [
          {
            path: [
              {
                kind: "node",
                node: {
                  variable: "person",
                  attributive_label: "PERSON",
                  node_source: "new",
                  alias_mode: "define",
                  properties: []
                }
              }
            ]
          }
        ]
      }
    ],
    parameters: []
  };
  assert.deepEqual(createInstanceGuardNodeLabels(query), ["PERSON"]);
  const nodeConstraints = new Map([
    [
      "PERSON",
      schemataConstraintMap([schematic({ key: "NAME", is_required: true, is_label: true })])
    ]
  ]);
  const issues = validateCreateInstances(query, nodeConstraints, new Map());
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /PERSON\.NAME is required/);
}

// --- cguard errors surface in builder warnings (so Create operation is not a silent no-op) ---
{
  const query = notebookTripleQuery();
  query.match[0].patterns[0].path[1].relationship.properties = [];
  const issues = validateCreateInstances(query, new Map(), relConstraintsForNotebook());
  const message = summarizeCreateGuardIssues(issues);
  const warnings = builderSelectors.warnings(
    builderState(query, {
      [CREATE_GUARD_CHECK_KEY]: { status: "error", message }
    })
  );
  assert.ok(
    warnings.some((w) => w.includes("IS_READ_ONLY")),
    `expected cguard message in warnings, got ${JSON.stringify(warnings)}`
  );
  assert.equal(
    builderSelectors.canSaveOperation(
      builderState(query, {
        [CREATE_GUARD_CHECK_KEY]: { status: "error", message }
      })
    ),
    false,
    "failing cguard still blocks save"
  );
}

{
  const query = notebookTripleQuery();
  const warnings = builderSelectors.warnings(builderState(query, {}));
  assert.ok(
    !warnings.some((w) => /cguard|schema/i.test(w) && /IS_READ_ONLY/.test(w)),
    "no cguard warning when the check is idle"
  );
}

console.log("create-instance-guard: ok");
