/**
 * Diagnostic: re-save regression for the rich-Cypher composer update.
 *
 * For every catalog operation with a hydratable builder_config, recompose its
 * QueryObject through the same path the builder uses on save
 * (normalizeForCompose -> composeQuery -> splitCypher) and compare against the
 * stored `queries.cypher` column. Any DIFF is an operation whose stored Cypher
 * would change on an untouched re-save.
 *
 * Known expected DIFF: operations whose cypher was hand-patched directly in the
 * catalog (see docs/ACTION-TYPES-SETUP.md in Life OS), e.g. ON_EVENT_TRIGGER's
 * UPDATE operation — the whole point of this update is to retire those patches.
 *
 * Run from App/ui: npx tsx ../../tests/diag-resave-regression.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import composer from "./helpers/composer.mjs";
import { normalizeForCompose } from "../App/authoring/src/normalize.ts";

const DB_PATH = fileURLToPath(new URL("../data.db", import.meta.url));

const rows = JSON.parse(
  execFileSync("sqlite3", [
    "-json",
    DB_PATH,
    "SELECT id, name, operation, kind, cypher, builder_config FROM queries"
  ]).toString() || "[]"
);

// Mirrors cypherStatementsForExecution in App/ui/src/services/execute.ts (the save
// path that populates queries.cypher); copied because execute.ts pulls in the
// browser connector.

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

const MATCH_TAIL_LINE =
  /^(WHERE|UNWIND|RETURN|WITH|ORDER BY|SKIP|LIMIT|SET|DELETE|DETACH DELETE|OPTIONAL\s+MATCH)\s/i;
const MATCH_LINE = /^(OPTIONAL\s+)?MATCH\s/i;

function groupCypherStatementsForExecution(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (MATCH_LINE.test(lines[i])) {
      const parts = [];
      while (i < lines.length && MATCH_LINE.test(lines[i])) {
        parts.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /^(MERGE|CREATE)\s/i.test(lines[i]) && !/^CREATE\s+INDEX\b/i.test(lines[i])) {
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

function cypherStatementsForExecution(cypher) {
  const semicolonChunks = (cypher || "").split(/\s*;\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (semicolonChunks.length > 1) {
    return cypherStatementsFromSemicolonChunks(cypher);
  }
  return groupCypherStatementsForExecution(splitCypherLines(cypher));
}

let same = 0;
const diffs = [];
let skipped = 0;

for (const row of rows) {
  let config;
  try {
    config = JSON.parse(row.builder_config);
  } catch {
    skipped += 1;
    continue;
  }
  // Same hydratability rule as isHydratableBuilderConfig.
  if (!config || typeof config !== "object" || !config.query || typeof config.query !== "object") {
    skipped += 1;
    continue;
  }
  // Auto-wrapped sequence rows store cypher from composeOneStepSequenceCypher (variable
  // `step`), while their synthesized builder_config snapshot uses builder variables —
  // a pre-existing, benign mismatch unrelated to operation re-saves. Skip them.
  if (row.kind === "sequence") {
    skipped += 1;
    continue;
  }
  let composed;
  try {
    composed = composer.composeQuery(normalizeForCompose(config.query));
  } catch (error) {
    diffs.push({ row, reason: `compose error: ${error.message}` });
    continue;
  }
  const fresh = JSON.stringify(cypherStatementsForExecution(composed.cypher));
  const stored = JSON.stringify(JSON.parse(row.cypher));
  if (fresh === stored) {
    same += 1;
  } else {
    diffs.push({ row, stored, fresh });
  }
}

for (const { row, reason, stored, fresh } of diffs) {
  console.log(`DIFF ${row.id} — ${row.name} (${row.operation})`);
  if (reason) {
    console.log(`  ${reason}`);
  } else {
    console.log(`  stored: ${stored}`);
    console.log(`  fresh : ${fresh}`);
  }
}

console.log(
  `diag-resave-regression: ${same} byte-identical, ${diffs.length} diff, ${skipped} without builder_config (of ${rows.length} rows)`
);
