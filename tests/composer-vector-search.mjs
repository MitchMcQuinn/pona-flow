/**
 * READ INSTANCE vector search composition.
 *
 * Covers:
 *  - the CALL / WHERE / RETURN / ORDER BY / LIMIT shape, returning the node itself
 *    (scalar projections would leave the results panel's graph view empty);
 *  - a per-node WHERE rendering as a post-filter after the index call;
 *  - the guards that fall back to a normal read (toggle off, non-INSTANCE, relationship
 *    hop, parameterized attributive_label, a node aliased `score`);
 *  - vector_query_text / vector_k declared on the catalog row so a sequence can
 *    override them, without landing in query.parameters;
 *  - the composed lines surviving cypherStatementsForExecution as ONE statement
 *    (a CALL head must glue its WHERE/RETURN/ORDER BY/LIMIT tail the way MATCH does,
 *    or Neo4j receives a bare `WHERE …` and rejects it);
 *  - all_labels dropping the label filter (and the WHERE line with it) for a broad
 *    search across every vectorized type.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";
import { VECTOR_SEARCH_MAX_K } from "../App/composer/src/index.ts";
import {
  cypherParamsFromQuery,
  cypherStatementsForExecution
} from "../App/authoring/src/packages.ts";
import {
  collectParameterOriginMeta,
  collectReferencedParameterNames,
  syncParametersFromReferences
} from "../App/authoring/src/parameterRefs.ts";
import { validateQuery } from "../App/authoring/src/validation.ts";

function vectorQuery(overrides = {}, nodeOverrides = {}) {
  return {
    id: "q-vector",
    name: "vector",
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
                node: {
                  variable: "PROJECT",
                  attributive_label: "PROJECT",
                  properties: [],
                  ...nodeOverrides
                }
              }
            ]
          }
        ]
      }
    ],
    return: { distinct: false, items: [] },
    vector_search: { enabled: true, text: "roadmap planning", k: 5 },
    ...overrides
  };
}

// --- base shape -------------------------------------------------------------
const base = composer.composeQuery(vectorQuery());
assert.equal(
  base.cypher,
  "CALL db.index.vector.queryNodes($vector_index, $vector_overfetch, $vector_query) YIELD node AS PROJECT, score\n" +
    "WHERE PROJECT.attributive_label = 'PROJECT'\n" +
    "RETURN PROJECT, score\n" +
    "ORDER BY score DESC\n" +
    "LIMIT $vector_k"
);

// The node object (not scalar projections) is what feeds the graph view.
assert.match(base.cypher, /RETURN PROJECT, score/);
assert.doesNotMatch(base.cypher, /PROJECT\.id AS id/);

// --- the splitter must keep it as one statement -----------------------------
// groupCypherStatementsForExecution used to glue a tail only under a MATCH head, so a
// CALL head emitted five statements and Neo4j got a standalone `WHERE …`.
const statements = cypherStatementsForExecution(base.cypher);
assert.equal(statements.length, 1);
assert.equal(
  statements[0],
  "CALL db.index.vector.queryNodes($vector_index, $vector_overfetch, $vector_query) YIELD node AS PROJECT, score " +
    "WHERE PROJECT.attributive_label = 'PROJECT' " +
    "RETURN PROJECT, score " +
    "ORDER BY score DESC " +
    "LIMIT $vector_k"
);

// --- per-node WHERE becomes a post-filter -----------------------------------
const filtered = composer.composeQuery(
  vectorQuery(
    {},
    {
      where_enabled: true,
      where: {
        operator: "AND",
        items: [{ property_key: "STATUS", operator: "=", value: "active" }]
      }
    }
  )
);
assert.match(
  filtered.cypher,
  /WHERE PROJECT\.attributive_label = 'PROJECT' AND \(PROJECT\.STATUS = 'active'\)/
);
// The filter runs after the index call, so the CALL still comes first.
assert.ok(filtered.cypher.indexOf("CALL db.index.vector") < filtered.cypher.indexOf("WHERE"));
assert.equal(cypherStatementsForExecution(filtered.cypher).length, 1);

// --- all_labels: broad search across every vectorized type ------------------
const broad = composer.composeQuery(
  vectorQuery({ vector_search: { enabled: true, text: "roadmap", k: 5, all_labels: true } })
);
// No label filter at all, so the WHERE line is dropped rather than left empty.
assert.equal(
  broad.cypher,
  "CALL db.index.vector.queryNodes($vector_index, $vector_overfetch, $vector_query) YIELD node AS PROJECT, score\n" +
    "RETURN PROJECT, score\n" +
    "ORDER BY score DESC\n" +
    "LIMIT $vector_k"
);
assert.doesNotMatch(broad.cypher, /attributive_label/);
assert.equal(cypherStatementsForExecution(broad.cypher).length, 1);

// A per-node WHERE still post-filters a broad search.
const broadFiltered = composer.composeQuery(
  vectorQuery(
    { vector_search: { enabled: true, text: "roadmap", k: 5, all_labels: true } },
    {
      where_enabled: true,
      where: {
        operator: "AND",
        items: [{ property_key: "STATUS", operator: "=", value: "active" }]
      }
    }
  )
);
assert.match(broadFiltered.cypher, /WHERE \(PROJECT\.STATUS = 'active'\)/);
assert.doesNotMatch(broadFiltered.cypher, /attributive_label/);
assert.equal(cypherStatementsForExecution(broadFiltered.cypher).length, 1);

// The label guards are relaxed: a broad search composes with no label at all,
// and with a $parameter label (both are ignored rather than rejected).
const broadNoLabel = composer.composeQuery(
  vectorQuery(
    { vector_search: { enabled: true, text: "t", k: 5, all_labels: true } },
    { attributive_label: "" }
  )
);
assert.match(broadNoLabel.cypher, /db\.index\.vector/);
assert.match(broadNoLabel.cypher, /YIELD node AS PROJECT, score/);

const broadParamLabel = composer.composeQuery(
  vectorQuery(
    { vector_search: { enabled: true, text: "t", k: 5, all_labels: true } },
    { attributive_label: "$projectType" }
  )
);
assert.match(broadParamLabel.cypher, /db\.index\.vector/);
assert.doesNotMatch(broadParamLabel.cypher, /projectType/);

// all_labels is compose-time only — it never becomes a catalog parameter.
const broadRows = composer.queryParametersForQueriesCatalog(
  vectorQuery({ vector_search: { enabled: true, text: "t", k: 5, all_labels: true } })
);
assert.equal(broadRows.find((r) => r.name === "all_labels"), undefined);
assert.ok(broadRows.find((r) => r.name === "vector_query_text"));
assert.ok(broadRows.find((r) => r.name === "vector_k"));

// all_labels without the toggle on changes nothing.
const broadButOff = composer.composeQuery(
  vectorQuery({ vector_search: { enabled: false, text: "t", k: 5, all_labels: true } })
);
assert.doesNotMatch(broadButOff.cypher, /db\.index\.vector/);

// --- ORDER BY / LIMIT from the query object are ignored ---------------------
const withOrder = composer.composeQuery(
  vectorQuery({
    limit: { value: 99 },
    order_by: [{ expression: "PROJECT.NAME", direction: "ASC" }],
    return: { distinct: true, items: [{ expression: "PROJECT.NAME" }] }
  })
);
assert.match(withOrder.cypher, /ORDER BY score DESC/);
assert.doesNotMatch(withOrder.cypher, /PROJECT\.NAME/);
assert.doesNotMatch(withOrder.cypher, /LIMIT 99/);
assert.doesNotMatch(withOrder.cypher, /DISTINCT/);

// --- guards: fall back to the ordinary read path ----------------------------
const toggledOff = composer.composeQuery(
  vectorQuery({ vector_search: { enabled: false, text: "x", k: 5 } })
);
assert.doesNotMatch(toggledOff.cypher, /db\.index\.vector/);
assert.match(toggledOff.cypher, /MATCH \(PROJECT:INSTANCE/);

const asStep = composer.composeQuery({
  ...vectorQuery(),
  match: [{ ...vectorQuery().match[0], label: "STEP" }]
});
assert.doesNotMatch(asStep.cypher, /db\.index\.vector/);

const withHop = composer.composeQuery({
  ...vectorQuery(),
  match: [
    {
      label: "INSTANCE",
      patterns: [
        {
          path: [
            { kind: "node", node: { variable: "PROJECT", attributive_label: "PROJECT", properties: [] } },
            {
              kind: "relationship",
              relationship: {
                variable: "r0",
                type: "POINTS_TO",
                direction: "outgoing",
                attributive_label: "HAS_TASK",
                properties: []
              }
            },
            { kind: "node", node: { variable: "TASK", attributive_label: "TASK", properties: [] } }
          ]
        }
      ]
    }
  ]
});
assert.doesNotMatch(withHop.cypher, /db\.index\.vector/);

const paramLabel = composer.composeQuery(vectorQuery({}, { attributive_label: "$projectType" }));
assert.doesNotMatch(paramLabel.cypher, /db\.index\.vector/);

const scoreAlias = composer.composeQuery(vectorQuery({}, { variable: "score" }));
assert.doesNotMatch(scoreAlias.cypher, /db\.index\.vector/);

const noLabel = composer.composeQuery(vectorQuery({}, { attributive_label: "" }));
assert.doesNotMatch(noLabel.cypher, /db\.index\.vector/);

// --- catalog parameters -----------------------------------------------------
const rows = composer.queryParametersForQueriesCatalog(vectorQuery());
const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
assert.equal(byName.vector_query_text.value, "roadmap planning");
assert.equal(byName.vector_query_text.value_type, "string");
assert.equal(byName.vector_query_text.is_required, true);
assert.equal(byName.vector_k.value, 5);
assert.equal(byName.vector_k.value_type, "integer");

// k is clamped to the engine's ceiling rather than rejected at compose time.
const clamped = composer.queryParametersForQueriesCatalog(
  vectorQuery({ vector_search: { enabled: true, text: "t", k: 5000 } })
);
assert.equal(clamped.find((r) => r.name === "vector_k").value, VECTOR_SEARCH_MAX_K);

// A non-vector read declares neither.
const plainRows = composer.queryParametersForQueriesCatalog(
  vectorQuery({ vector_search: { enabled: false, text: "", k: 10 } })
);
assert.equal(plainRows.find((r) => r.name === "vector_query_text"), undefined);
assert.equal(plainRows.find((r) => r.name === "vector_k"), undefined);

// --- parameterized text and k -----------------------------------------------
// An author names the parameters so a sequence can populate them, and so two vector
// searches in one sequence do not collide on the reserved names.
function parameterized(overrides = {}) {
  return vectorQuery({
    parameters: [
      { name: "searchTerm", data_type: "string", value: "" },
      { name: "topK", data_type: "integer", value: 10 }
    ],
    vector_search: { enabled: true, text: "$searchTerm", k: { parameter: "topK" } },
    ...overrides
  });
}

// Only the LIMIT changes: the text never appears in Cypher either way.
const paramK = composer.composeQuery(parameterized());
assert.match(paramK.cypher, /LIMIT \$topK$/);
assert.doesNotMatch(paramK.cypher, /\$vector_k/);
assert.doesNotMatch(paramK.cypher, /searchTerm/);
assert.equal(cypherStatementsForExecution(paramK.cypher).length, 1);

// A literal k alongside a parameterized text keeps the reserved LIMIT.
const paramTextOnly = composer.composeQuery(
  parameterized({ vector_search: { enabled: true, text: "$searchTerm", k: { value: 5 } } })
);
assert.match(paramTextOnly.cypher, /LIMIT \$vector_k$/);

// The author's own rows carry the role marker; the reserved rows are not pushed,
// which is how the engine knows which value to embed and which to LIMIT by.
const paramRows = composer.queryParametersForQueriesCatalog(parameterized());
const paramByName = Object.fromEntries(paramRows.map((r) => [r.name, r]));
assert.equal(paramByName.searchTerm.vector_role, "text");
assert.equal(paramByName.topK.vector_role, "k");
assert.equal(paramRows.find((r) => r.name === "vector_query_text"), undefined);
assert.equal(paramRows.find((r) => r.name === "vector_k"), undefined);

// Mixed: a literal k still declares the reserved row, and only text is tagged.
const mixedRows = composer.queryParametersForQueriesCatalog(
  parameterized({ vector_search: { enabled: true, text: "$searchTerm", k: { value: 7 } } })
);
const mixedByName = Object.fromEntries(mixedRows.map((r) => [r.name, r]));
assert.equal(mixedByName.searchTerm.vector_role, "text");
assert.equal(mixedByName.topK.vector_role, undefined);
assert.equal(mixedByName.vector_k.value, 7);
assert.equal(mixedRows.find((r) => r.name === "vector_query_text"), undefined);

// Discovery: both names register as referenced, typed and locked like SKIP/LIMIT.
const refs = collectReferencedParameterNames(parameterized());
assert.ok(refs.includes("searchTerm"));
assert.ok(refs.includes("topK"));
const meta = collectParameterOriginMeta(parameterized());
assert.equal(meta.get("searchTerm").value_type, "string");
assert.equal(meta.get("searchTerm").locked, true);
assert.equal(meta.get("searchTerm").is_required, true);
assert.equal(meta.get("topK").value_type, "integer");
assert.equal(meta.get("topK").locked, true);

// An author who never declared the parameters gets them materialized by the same
// auto-discovery that backs every other $name field.
const synced = syncParametersFromReferences(parameterized({ parameters: [] }));
assert.deepEqual(synced.parameters.map((p) => p.name).sort(), ["searchTerm", "topK"]);

// Run path: a parameterized field is bound from query.parameters, so nothing is
// synthesized under the reserved name (there is no value to synthesize).
const paramRunParams = cypherParamsFromQuery(parameterized());
assert.equal("vector_query_text" in paramRunParams, false);
assert.equal("vector_k" in paramRunParams, false);
const literalRunParams = cypherParamsFromQuery(vectorQuery());
assert.equal(literalRunParams.vector_query_text, "roadmap planning");
assert.equal(literalRunParams.vector_k, 5);

// Validation: a $param satisfies the text requirement and skips the k range check.
const paramWarnings = validateQuery(parameterized(), false);
assert.equal(paramWarnings.find((w) => /search text/i.test(w)), undefined);
assert.equal(paramWarnings.find((w) => /k must be an integer/i.test(w)), undefined);

// A literal out-of-range k is still caught at author time.
assert.ok(
  validateQuery(
    vectorQuery({ vector_search: { enabled: true, text: "t", k: { value: 5000 } } }),
    false
  ).some((w) => /k must be an integer/i.test(w))
);

// The reserved names remain off limits as author-chosen parameters.
assert.ok(
  validateQuery(
    vectorQuery({
      parameters: [{ name: "vector_query_text", data_type: "string", value: "" }]
    }),
    false
  ).some((w) => /vector_query_text/.test(w))
);

console.log("composer-vector-search: ok");
