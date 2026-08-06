/**
 * Multi-pattern SCHEMA create: each pattern is a separate MERGE statement separated by ';'.
 */
import assert from "node:assert/strict";
import composer from "./helpers/composer.mjs";

const MATCH_TAIL_LINE =
  /^(WHERE|RETURN|WITH|ORDER BY|SKIP|LIMIT|SET|DELETE|DETACH DELETE)\s/i;

function splitCypherLines(cypherText) {
  const chunks = (cypherText || "").split(/\s*;\s*\n/);
  const lines = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      lines.push(trimmed);
    }
  }
  return lines;
}

function cypherStatementsFromSemicolonChunks(cypherText) {
  return (cypherText || "")
    .split(/\s*;\s*\n/)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"))
        .join(" ")
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

function cypherStatementsForExecution(cypherText) {
  const semicolonChunks = (cypherText || "").split(/\s*;\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (semicolonChunks.length > 1) {
    return cypherStatementsFromSemicolonChunks(cypherText);
  }
  return groupCypherStatementsForExecution(splitCypherLines(cypherText));
}

function groupCypherStatementsForExecution(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^MATCH\s/i.test(lines[i])) {
      const parts = [];
      while (i < lines.length && /^MATCH\s/i.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      if (
        i < lines.length &&
        /^(MERGE|CREATE)\s/i.test(lines[i]) &&
        !/^CREATE\s+INDEX\b/i.test(lines[i])
      ) {
        parts.push(lines[i]);
        i += 1;
        if (i < lines.length && /^RETURN\s/i.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      } else {
        while (i < lines.length && MATCH_TAIL_LINE.test(lines[i])) {
          parts.push(lines[i]);
          i += 1;
        }
      }
      out.push(parts.join(" "));
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out;
}

const query = {
  operation: "create",
  allow_duplicates: false,
  match: [
    {
      label: "SCHEMA",
      patterns: [
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "P",
                attributive_label: "PERSON",
                id_binding: { key: "id", value: "ID_person" },
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r1",
                attributive_label: "WORKS_AT",
                id_binding: { key: "id", value: "ID_r1" },
                properties: []
              }
            },
            {
              kind: "node",
              node: {
                variable: "c1",
                attributive_label: "COMPANY",
                id_binding: { key: "id", value: "ID_company" },
                properties: []
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r3",
                attributive_label: "STOCKS",
                id_binding: { key: "id", value: "ID_r3" },
                properties: []
              }
            },
            {
              kind: "node",
              node: {
                variable: "prod",
                attributive_label: "PRODUCT",
                id_binding: { key: "id", value: "ID_product" },
                properties: []
              }
            }
          ]
        },
        {
          path: [
            {
              kind: "node",
              node: {
                variable: "P",
                alias_mode: "reference",
                alias_ref: "P",
                attributive_label: "PERSON"
              }
            },
            {
              kind: "relationship",
              relationship: {
                variable: "r2",
                attributive_label: "BOUGHT_PRODUCT",
                id_binding: { key: "id", value: "ID_r2" },
                properties: []
              }
            },
            {
              kind: "node",
              node: {
                variable: "prod",
                alias_mode: "reference",
                alias_ref: "prod",
                attributive_label: "PRODUCT"
              }
            }
          ]
        }
      ]
    }
  ],
  parameters: []
};

const { cypher } = composer.composeQuery(query);
assert.match(cypher, /;\s*\n/, "create cypher should separate statements with semicolon");
const parts = cypher.split(/\s*;\s*\n/).map((s) => s.trim()).filter(Boolean);
assert.equal(parts.length, 2, "expected two MERGE statements");

const grouped = cypherStatementsForExecution(cypher);
assert.equal(grouped.length, 2, "execution should run two separate statements");
assert.doesNotMatch(
  grouped[0],
  /\bRETURN\s+\*\s+MATCH\b/i,
  "must not glue two CREATE statements into one"
);
assert.match(grouped[0], /^MERGE /);
assert.match(grouped[0], /RETURN \*$/);
assert.match(
  grouped[1],
  /^MATCH \(P:SCHEMA \{ attributive_label: 'PERSON', id: 'ID_person' \}\)/
);
assert.match(
  grouped[1],
  /MATCH \(prod:SCHEMA \{ attributive_label: 'PRODUCT', id: 'ID_product' \}\)/
);
assert.match(grouped[1], /MERGE \(P\)-\[r2:[^\]]+\]->\(prod\)/);
assert.doesNotMatch(grouped[0], /MERGE[^\n]*\]-\(/, "relationships should use forward arrows");
assert.match(grouped[1], /RETURN \*$/);

console.log("cypher-create-multi-pattern: ok");
