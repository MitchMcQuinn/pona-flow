/** READ INSTANCE vector-index search: CALL db.index.vector.queryNodes + post-filters. */

import { escapeCypherString, exactParameterName, renderLiteralOrParameter } from "../literals.js";
import { pathElementWhereBody } from "./where.js";
import type { LiteralOrParameter, NodePattern, PathElement, QueryObject } from "../types.js";

/** Author-facing: search text. Declared on the catalog so sequences can override it. */
export const VECTOR_PARAM_TEXT = "vector_query_text";
/** Author-facing: top-k. Declared on the catalog so sequences can override it. */
export const VECTOR_PARAM_K = "vector_k";
/** Engine-filled: the embedding float list. Never authored by the client. */
export const VECTOR_PARAM_QUERY = "vector_query";
/** Engine-filled: Neo4j index name. */
export const VECTOR_PARAM_INDEX = "vector_index";
/** Engine-filled: overfetch before the attributive_label filter. */
export const VECTOR_PARAM_OVERFETCH = "vector_overfetch";

/** Names reserved for vector search — authors must not declare these as parameters. */
export const VECTOR_RESERVED_PARAM_NAMES = new Set([
  VECTOR_PARAM_TEXT,
  VECTOR_PARAM_K,
  VECTOR_PARAM_QUERY,
  VECTOR_PARAM_INDEX,
  VECTOR_PARAM_OVERFETCH,
]);

export const VECTOR_SEARCH_DEFAULT_K = 10;
export const VECTOR_SEARCH_MAX_K = 100;

const ATTRIBUTIVE_LABEL_PARAM_RE = /^\$(?![0-9])([A-Za-z_][A-Za-z0-9_]*)$/;

interface SingleInstanceNode {
  node: NodePattern;
  element: PathElement;
}

/** True when the query opts into vector search (regardless of whether it can compose). */
export function isVectorSearchEnabled(query: QueryObject | null | undefined): boolean {
  return Boolean(query && query.vector_search && query.vector_search.enabled === true);
}

/**
 * True when the search spans every vectorized type instead of the selected
 * attributive_label. Only meaningful while vector search is enabled.
 */
export function isVectorSearchAllLabels(query: QueryObject | null | undefined): boolean {
  return isVectorSearchEnabled(query) && query!.vector_search!.all_labels === true;
}

type VectorSearchConfigK = LiteralOrParameter | number | undefined;

/** Clamp an author-supplied k into the range the engine accepts. */
function clampK(raw: unknown): number {
  let k = Number(raw);
  if (!Number.isFinite(k) || k <= 0) return VECTOR_SEARCH_DEFAULT_K;
  k = Math.floor(k);
  return k > VECTOR_SEARCH_MAX_K ? VECTOR_SEARCH_MAX_K : k;
}

/**
 * k as a LiteralOrParameter. Snapshots saved before k could be parameterized hold a
 * bare number, so widen those rather than treating them as an absent value.
 */
export function normalizeVectorK(k: VectorSearchConfigK): LiteralOrParameter {
  if (k === null || k === undefined) return null;
  if (typeof k === "number") return { value: clampK(k) };
  if (typeof k === "object" && "parameter" in k && k.parameter) return { parameter: k.parameter };
  if (typeof k === "object" && "value" in k) return { value: clampK(k.value) };
  return null;
}

/** Parameter name backing the search text, or null when it is a literal. */
export function vectorTextParameterName(query: QueryObject | null | undefined): string | null {
  if (!isVectorSearchEnabled(query)) return null;
  return exactParameterName(query!.vector_search!.text);
}

/** Parameter name backing k, or null when it is a literal. */
export function vectorKParameterName(query: QueryObject | null | undefined): string | null {
  if (!isVectorSearchEnabled(query)) return null;
  const k = normalizeVectorK(query!.vector_search!.k);
  return k && "parameter" in k && k.parameter ? k.parameter : null;
}

/** The literal k an author typed, clamped. VECTOR_SEARCH_DEFAULT_K when parameterized. */
export function vectorKLiteral(query: QueryObject | null | undefined): number {
  if (!isVectorSearchEnabled(query)) return VECTOR_SEARCH_DEFAULT_K;
  const k = normalizeVectorK(query!.vector_search!.k);
  if (k && "value" in k) return clampK(k.value);
  return VECTOR_SEARCH_DEFAULT_K;
}

function findSingleInstanceNode(query: QueryObject): SingleInstanceNode | null {
  let found: SingleInstanceNode | null = null;
  let nodeCount = 0;
  let hasRelationship = false;
  for (const clause of query.match || []) {
    if ((clause.label || "") !== "INSTANCE") return null;
    for (const pattern of clause.patterns || []) {
      for (const element of pattern.path || []) {
        if (element.kind === "relationship") {
          hasRelationship = true;
          continue;
        }
        if (element.kind === "node") {
          nodeCount += 1;
          if (nodeCount > 1) return null;
          found = { node: element.node, element };
        }
      }
    }
  }
  if (hasRelationship || nodeCount !== 1 || !found) return null;
  return found;
}

/**
 * Cypher lines for a READ INSTANCE vector search, or null when the query is not an
 * applicable vector-search read (toggle off, wrong operation/label, multi-hop, etc.).
 *
 * Emits a Neo4j vector-index CALL. The engine fills ``$vector_query`` /
 * ``$vector_index`` / ``$vector_overfetch`` before the statement runs.
 */
export function composeVectorSearchLines(query: QueryObject): string[] | null {
  if ((query.operation || "read") !== "read") return null;
  if (!isVectorSearchEnabled(query)) return null;

  const single = findSingleInstanceNode(query);
  if (!single) return null;

  // A broad search spans the whole :INSTANCE index, so the selected label is ignored
  // and need not be a concrete one.
  const allLabels = isVectorSearchAllLabels(query);
  const attributiveLabel = String(single.node.attributive_label || "").trim();
  if (!allLabels && (!attributiveLabel || ATTRIBUTIVE_LABEL_PARAM_RE.test(attributiveLabel))) {
    return null;
  }

  const labelDerivedVariable = allLabels ? "" : attributiveLabel.replace(/[^A-Za-z0-9_]/g, "_");
  const variable = String(single.node.variable || "").trim() || labelDerivedVariable || "n";
  if (variable.toLowerCase() === "score") return null;

  const whereParts: string[] = [];
  if (!allLabels) {
    whereParts.push(`${variable}.attributive_label = ${escapeCypherString(attributiveLabel)}`);
  }
  const pathWhere = pathElementWhereBody(single.element);
  if (pathWhere) whereParts.push(pathWhere);

  const lines: string[] = [
    `CALL db.index.vector.queryNodes($${VECTOR_PARAM_INDEX}, $${VECTOR_PARAM_OVERFETCH}, $${VECTOR_PARAM_QUERY}) YIELD node AS ${variable}, score`,
  ];
  // A broad search with no per-node filter has nothing to post-filter on.
  if (whereParts.length) lines.push(`WHERE ${whereParts.join(" AND ")}`);
  // A parameterized k binds the author's own name; a literal one keeps the reserved
  // $vector_k, which the engine fills alongside the embedding.
  const kParameter = vectorKParameterName(query);
  const limit = kParameter
    ? renderLiteralOrParameter({ parameter: kParameter })
    : `$${VECTOR_PARAM_K}`;
  lines.push(`RETURN ${variable}, score`, "ORDER BY score DESC", `LIMIT ${limit}`);
  return lines;
}
