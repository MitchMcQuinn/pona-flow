/**
 * One-time catalog migration: move saved create-INSTANCE operations from baked
 * literal ids to run-time-minted id parameters.
 *
 * Before this migration, the composer baked the save-time UID into the stored
 * Cypher (`id: 'ID_…'`), so every run of a create sequence MERGEd onto the same
 * node (the CREATE_PILLAR "all pillars share one id" bug). The composer now emits
 * `id: $id__<variable>` and the engine mints a fresh UID per run.
 *
 * What this script does:
 *  1. Loads every catalog operation (GET /api/queries + /api/queries/{id}).
 *  2. Recomposes each create-INSTANCE operation from its stored builder_config
 *     under the new composer rules and collects the retired literal ids
 *     (old baked id -> new $id__<variable> parameter).
 *  3. Rewrites other operations whose existing-target id_binding referenced a
 *     retired literal to the corresponding parameter, declaring it as a required
 *     query parameter (in a sequence it resolves automatically from the create
 *     step's minted id; standalone runs pause and ask for it).
 *  4. Reports any remaining catalog rows whose stored Cypher still mentions a
 *     retired literal (sequences, hand-written rows) without touching them.
 *
 * Only the SQLite catalog is written (via /api/queries/upsert); the Neo4j graph
 * is never modified.
 *
 * Usage (dry run by default; tsx lives in App/ui):
 *   cd App/ui
 *   npx tsx ../../tools/migrate-runtime-ids.mjs [--api http://localhost:8000] [--apply] [--auth <bearer>]
 */
import composerModule from "../App/composer/src/index.ts";
import { instanceCreateIdParamName } from "../App/composer/src/entity/ids.ts";

const composer = composerModule;

// --- CLI arguments -----------------------------------------------------------

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
}
const API_BASE = (argValue("--api") || process.env.MIGRATE_API_BASE || "http://localhost:8000").replace(/\/$/, "");
const APPLY = args.includes("--apply");
const AUTH = argValue("--auth") || process.env.MIGRATE_AUTH_BEARER || "";

async function api(path, init = {}) {
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (AUTH) headers.Authorization = `Bearer ${AUTH}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed (${res.status}): ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

// --- Cypher statement splitting (mirrors App/ui/src/services/execute.ts) ------

const MATCH_TAIL_LINE =
  /^(WHERE|UNWIND|RETURN|WITH|ORDER BY|SKIP|LIMIT|SET|DELETE|DETACH DELETE|OPTIONAL\s+MATCH)\s/i;
const MATCH_LINE = /^(OPTIONAL\s+)?MATCH\s/i;

function splitCypherLines(cypherText) {
  const lines = [];
  for (const chunk of (cypherText || "").split(/\s*;\s*\n/)) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      lines.push(trimmed);
    }
  }
  return lines;
}

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
  if (semicolonChunks.length > 1) return cypherStatementsFromSemicolonChunks(cypher);
  return groupCypherStatementsForExecution(splitCypherLines(cypher));
}

function isQueriesCatalogUpsertSql(stmt) {
  const t = String(stmt || "").trim().replace(/\s+/g, " ");
  return /^INSERT\s+INTO\s+queries\s/i.test(t) && /\bON\s+CONFLICT\s*\(\s*id\s*\)/i.test(t);
}

// --- Builder-config helpers ----------------------------------------------------

/** normalizeForCompose subset that matters for create ops: cypher_condition -> condition. */
function normalizeForCompose(query) {
  return {
    ...query,
    match: (query.match || []).map((clause) => ({
      ...clause,
      patterns: (clause.patterns || []).map((pattern) => ({
        ...pattern,
        path: (pattern.path || []).map((el) => {
          if (el.kind === "relationship" && el.relationship?.condition_type === "cypher" && el.relationship.cypher_condition) {
            return {
              kind: "relationship",
              relationship: {
                ...el.relationship,
                condition: composer.buildExistsInstanceCondition(el.relationship.cypher_condition)
              }
            };
          }
          return el;
        })
      }))
    }))
  };
}

function* createInstanceEntities(query) {
  for (const clause of query.match || []) {
    if ((clause.label || "") !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        const entity = el.kind === "node" ? el.node : el.relationship;
        if (!entity) continue;
        yield { entity, entityKind: el.kind === "node" ? "node" : "relationship" };
      }
    }
  }
}

/** Retired literal ids for a create query: baked id -> new run-time parameter name. */
function retiredLiteralIds(query) {
  const retired = new Map();
  if ((query.operation || "") !== "create") return retired;
  for (const { entity, entityKind } of createInstanceEntities(query)) {
    const param = instanceCreateIdParamName(entity, {
      clauseLabel: "INSTANCE",
      operation: "create",
      entityKind
    });
    if (!param) continue;
    const keyProp = (entity.properties || []).find((p) => p?.schematic_properties?.is_key);
    const keyVal = String(keyProp?.value ?? "").trim();
    if (keyVal && keyVal.toLowerCase() !== "null") retired.set(keyVal, param);
    const bindingVal = String(entity.id_binding?.value ?? "").trim();
    if (bindingVal && !bindingVal.startsWith("$")) retired.set(bindingVal, param);
  }
  return retired;
}

/** Rewrite existing-target id_bindings that reference a retired literal; returns rewrites. */
function rewriteRetiredReferences(query, retired) {
  const rewrites = [];
  for (const clause of query.match || []) {
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        const entity = el.kind === "node" ? el.node : el.relationship;
        if (!entity || entity.node_source !== "existing") continue;
        const binding = entity.id_binding;
        const value = typeof binding?.value === "string" ? binding.value.trim() : "";
        if (!value || !retired.has(value)) continue;
        const param = retired.get(value);
        entity.id_binding = { key: "id", value: `$${param}` };
        rewrites.push({ oldId: value, param });
        declareParameter(query, param);
      }
    }
  }
  return rewrites;
}

/** Declare a rewritten reference as a required run-time parameter (if not present). */
function declareParameter(query, name) {
  query.parameters = query.parameters || [];
  if (query.parameters.some((p) => String(p?.name || "").trim() === name)) return;
  query.parameters.push({
    name,
    data_type: "string",
    value: "",
    is_required: true,
    description:
      "Graph id of the referenced instance. Resolved automatically when the creating step runs earlier in the same sequence.",
    schematic_properties: {
      value_type: "string",
      format: "any",
      is_required: true,
      is_key: false,
      is_label: false,
      is_indexed: false
    }
  });
}

async function upsertOperation(row, pkg, query) {
  const composed = composer.composeQuery(normalizeForCompose(query));
  const payload = {
    id: pkg.id,
    name: row.name,
    kind: "operation",
    operation: query.operation,
    runtime_enabled: Boolean(row.runtime_enabled),
    author_selectable: Boolean(row.author_selectable),
    group_title: row.group_title || undefined,
    cypher: cypherStatementsForExecution(composed.cypher),
    sqlite: composed.sqlite.filter((s) => !isQueriesCatalogUpsertSql(s)),
    parameters: composer.queryParametersForQueriesCatalog(query),
    description: row.description || undefined,
    builder_config: pkg.builder_config
  };
  if (APPLY) {
    await api("/api/queries/upsert", { method: "POST", body: JSON.stringify(payload) });
  }
  return payload;
}

// --- Main -----------------------------------------------------------------------

async function main() {
  console.log(`API: ${API_BASE}  mode: ${APPLY ? "APPLY" : "dry run (pass --apply to write)"}`);
  const { queries: rows } = await api("/api/queries");
  const operations = rows.filter((r) => r.kind === "operation");

  // Pass 1: load builder configs and collect retired literal ids per create op.
  const loaded = [];
  const retiredAll = new Map(); // oldId -> param name
  for (const row of operations) {
    const pkg = await api(`/api/queries/${encodeURIComponent(row.id)}`);
    const query = pkg?.builder_config?.query;
    if (!query || !Array.isArray(query.match)) {
      loaded.push({ row, pkg, query: null, migrate: false });
      continue;
    }
    const retired = retiredLiteralIds(query);
    const migrate = composer.autoGeneratedIdParameterNames(query).length > 0;
    for (const [oldId, param] of retired) {
      if (retiredAll.has(oldId) && retiredAll.get(oldId) !== param) {
        console.warn(`  ! literal ${oldId} is minted by two operations with different parameters; keeping ${retiredAll.get(oldId)}`);
        continue;
      }
      retiredAll.set(oldId, param);
    }
    loaded.push({ row, pkg, query, migrate });
  }

  // Pass 2: rewrite cross-references and re-save everything that changed.
  let migrated = 0;
  let rewritten = 0;
  const newCypherById = new Map(); // migrated/rewritten op id -> post-migration cypher
  for (const item of loaded) {
    if (!item.query) continue;
    const rewrites = rewriteRetiredReferences(item.query, retiredAll);
    if (!item.migrate && rewrites.length === 0) continue;

    const payload = await upsertOperation(item.row, item.pkg, item.query);
    newCypherById.set(item.row.id, payload.cypher);
    if (item.migrate) {
      migrated += 1;
      const params = composer.autoGeneratedIdParameterNames(item.query);
      console.log(`- migrated create op "${item.row.name}" (${item.row.id}): mints ${params.map((p) => `$${p}`).join(", ")}`);
    }
    for (const rw of rewrites) {
      rewritten += 1;
      console.log(`- rewrote reference in "${item.row.name}" (${item.row.id}): ${rw.oldId} -> $${rw.param}`);
    }
    if (!APPLY) {
      console.log(`  (dry run) would store cypher: ${payload.cypher.join(" | ")}`);
    }
  }

  // Pass 3: report catalog rows still mentioning a retired literal (not rewritten).
  // Rows changed in pass 2 are scanned by their post-migration cypher.
  const retiredIds = [...retiredAll.keys()];
  if (retiredIds.length) {
    for (const row of rows) {
      const cypher = newCypherById.get(row.id) ?? row.cypher ?? [];
      const text = JSON.stringify(cypher);
      const hits = retiredIds.filter((id) => text.includes(id));
      if (hits.length) {
        console.warn(
          `! ${row.kind} "${row.name}" (${row.id}) still references retired id(s) ${hits.join(", ")} in its stored cypher — review manually.`
        );
      }
    }
  }

  console.log(`\nDone. ${migrated} create operation(s) migrated, ${rewritten} reference(s) rewritten.`);
  if (!APPLY) console.log("No changes were written (dry run). Re-run with --apply to persist.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
