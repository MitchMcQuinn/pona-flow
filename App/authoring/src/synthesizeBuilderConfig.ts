/**
 * Rebuild a visual-builder snapshot from a catalog row that was saved as Cypher only.
 *
 * Chat-agent operations and sequences persist `cypher` and leave `builder_config` empty.
 * The composer is forward-only, so the editor cannot reopen those rows until this module
 * reconstructs a QueryObject. Statements the builder cannot represent (WITH, UNION, CALL,
 * an undirected hop, …) return null — opening a lossy form would overwrite the saved
 * Cypher on the next save.
 */

import { isHydratableBuilderConfig } from "./builderConfig.js";
import type {
  BuilderConfig,
  ConditionType,
  DeleteClause,
  GraphNodeLabel,
  LiteralOrParameter,
  MatchClause,
  NodePattern,
  Operation,
  OrderByItem,
  Parameter,
  PathElement,
  PropertyBinding,
  QueryObject,
  RelationshipLength,
  RelationshipPattern,
  ReturnItem,
  UnwindClause,
  WhereGroup,
} from "./types.js";

const GRAPH_LABELS = new Set<GraphNodeLabel>(["STEP", "SCHEMA", "INSTANCE"]);
const CONDITION_TYPES = new Set<ConditionType>(["null", "cypher", "implicit", "query", "parameter"]);

const CLAUSE_KEYWORDS: { kind: string; phrase: string }[] = [
  { kind: "optional", phrase: "OPTIONAL MATCH" },
  { kind: "detach_delete", phrase: "DETACH DELETE" },
  { kind: "order", phrase: "ORDER BY" },
  { kind: "match", phrase: "MATCH" },
  { kind: "where", phrase: "WHERE" },
  { kind: "return", phrase: "RETURN" },
  { kind: "delete", phrase: "DELETE" },
  { kind: "create", phrase: "CREATE" },
  { kind: "merge", phrase: "MERGE" },
  { kind: "unwind", phrase: "UNWIND" },
  { kind: "skip", phrase: "SKIP" },
  { kind: "limit", phrase: "LIMIT" },
  { kind: "set", phrase: "SET" },
];

const BLOCKING_PHRASES = ["LOAD CSV", "FOREACH", "UNION", "CALL", "WITH", "REMOVE", "YIELD", "USE"];

class CypherShapeError extends Error {}

export interface SynthesizeBuilderInput {
  id: string;
  name?: string;
  operation?: string | null;
  cypher?: string | string[] | null;
  parameters?: unknown;
}

/** Use a stored snapshot when it has a query; otherwise rebuild one from Cypher. */
export function configForVisualEdit(
  input: SynthesizeBuilderInput & { builder_config?: unknown }
): BuilderConfig | null {
  if (isHydratableBuilderConfig(input.builder_config)) return input.builder_config;
  return synthesizeBuilderConfig(input);
}

/** A builder snapshot for `cypher`, or null when the statement is not a builder query. */
export function synthesizeBuilderConfig(input: SynthesizeBuilderInput): BuilderConfig | null {
  try {
    const query = parseQuery(input);
    if (!query) return null;
    return { version: 1, query, runtimeEnabled: true, matchPositions: {} };
  } catch (err) {
    if (err instanceof CypherShapeError) return null;
    throw err;
  }
}

function parseQuery(input: SynthesizeBuilderInput): QueryObject | null {
  const statements = statementsOf(input.cypher);
  if (statements.length !== 1) return null;
  const statement = statements[0];
  if (hasBlockingKeyword(statement)) throw new CypherShapeError("blocking");

  const special = parseSpecialRead(statement);
  if (special) {
    special.id = (input.id || "").trim() || "query";
    special.name = input.name || "";
    special.parameters = collectParameters(input.parameters, statement);
    return special;
  }

  const clauses = splitClauses(statement);
  const operation = resolveOperation(input.operation, clauses);
  const defined = new Set<string>();
  const match: MatchClause[] = [];
  let where: WhereGroup | undefined;
  let setExprs: string[] | undefined;
  let deleted: DeleteClause | undefined;
  let ret: { distinct: boolean; items: ReturnItem[] } | undefined;
  let order: OrderByItem[] | undefined;
  let skip: LiteralOrParameter | undefined;
  let limit: LiteralOrParameter | undefined;
  let unwind: UnwindClause | undefined;
  let allowDuplicates = false;

  for (const clause of clauses) {
    if (clause.kind === "match" || clause.kind === "optional" || clause.kind === "create" || clause.kind === "merge") {
      if (clause.kind === "create") allowDuplicates = true;
      match.push(parseMatchClause(clause.body, clause.kind === "optional", defined));
    } else if (clause.kind === "where") {
      const expression = clause.body.trim();
      if (!expression) throw new CypherShapeError("where");
      where = where ?? { operator: "AND", items: [] };
      where.items.push({ expression });
    } else if (clause.kind === "set") {
      const items = splitTop(clause.body).map((part) => part.trim()).filter(Boolean);
      if (!items.length) throw new CypherShapeError("set");
      setExprs = items;
    } else if (clause.kind === "delete" || clause.kind === "detach_delete") {
      const targets = splitTop(clause.body).map((part) => part.trim()).filter(Boolean);
      if (!targets.length || targets.some((target) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target))) {
        throw new CypherShapeError("delete");
      }
      deleted = { detach: clause.kind === "detach_delete", targets };
    } else if (clause.kind === "return") {
      ret = parseReturn(clause.body);
    } else if (clause.kind === "order") {
      order = parseOrder(clause.body);
    } else if (clause.kind === "skip") {
      skip = parseLiteralOrParameter(clause.body);
    } else if (clause.kind === "limit") {
      limit = parseLiteralOrParameter(clause.body);
    } else if (clause.kind === "unwind") {
      unwind = parseUnwind(clause.body);
    }
  }

  if (where && operation === "create") throw new CypherShapeError("where");
  if (unwind && operation !== "read") throw new CypherShapeError("unwind");
  if (setExprs && operation !== "update") throw new CypherShapeError("set");
  if (deleted && operation !== "delete") throw new CypherShapeError("delete");
  if (
    operation === "create" &&
    clauses.some((clause) => clause.kind === "match" || clause.kind === "optional")
  ) {
    throw new CypherShapeError("match");
  }
  if (clauses.some((clause) => clause.kind === "create" || clause.kind === "merge") && operation !== "create") {
    throw new CypherShapeError("create");
  }
  if (ret && operation === "delete") throw new CypherShapeError("return");
  if (ret && operation === "create" && ret.items.length) throw new CypherShapeError("return");
  if (ret && operation === "update" && !ret.items.length) throw new CypherShapeError("return");
  if (!match.length && !(ret && ret.items.length) && !setExprs && !deleted) return null;

  if (operation === "create") {
    for (const clause of match) {
      for (const pattern of clause.patterns) {
        for (const element of pattern.path) {
          if (element.kind === "node" && element.node.alias_mode !== "reference" && !element.node.node_source) {
            element.node.node_source = "new";
          }
        }
      }
    }
  }

  const query: QueryObject = {
    id: (input.id || "").trim() || "query",
    name: input.name || "",
    operation,
    parameters: collectParameters(input.parameters, statement),
    match,
    where,
    return:
      operation === "read"
        ? ret ?? { distinct: false, items: [] }
        : operation === "update" && ret
          ? ret
          : undefined,
    set: operation === "update" ? (setExprs ?? []).map((expression) => ({ expression })) : undefined,
    delete: operation === "delete" ? deleted ?? { detach: false, targets: [] } : undefined,
    unwind,
    order_by: order,
    skip,
    limit,
    allow_duplicates: operation === "create" ? allowDuplicates : false,
    hide_duplicates: false,
  };
  if (operation === "update" && !query.set?.length) query.set = [{ expression: "" }];
  if (operation !== "read") {
    // ORDER BY / SKIP / LIMIT / UNWIND only compose for reads. Keep them only there
    // so a later visual save cannot drop a clause the form does not show.
    if (order || skip || limit || unwind) throw new CypherShapeError("read-only clause");
  }
  if (operation === "read" && !query.return) query.return = { distinct: false, items: [] };
  return query;
}

function parseSpecialRead(statement: string): QueryObject | null {
  const flat = statement.replace(/\s+/g, " ").trim();
  const traversal = flat.match(
    /^MATCH path = \(:([A-Za-z_][A-Za-z0-9_]*)(?: \{\s*attributive_label\s*:\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|\$[A-Za-z_][A-Za-z0-9_]*)\s*\})?\)-\[\*\](->|-)\((downstream|connected)\) RETURN path$/i
  );
  if (traversal) {
    const label = traversal[1].toUpperCase();
    if (label !== "STEP" && label !== "SCHEMA") return null;
    const graphLabel: GraphNodeLabel = label === "STEP" ? "STEP" : "SCHEMA";
    const arrow = traversal[3];
    const end = traversal[4].toLowerCase();
    const mode =
      arrow === "->" && end === "downstream"
        ? "downstream"
        : arrow === "-" && end === "connected"
          ? "network"
          : null;
    if (!mode) return null;
    const node = blankNode("n");
    node.labels = [graphLabel];
    const attributive = unquoteAttributive(traversal[2]);
    if (attributive) node.attributive_label = attributive;
    return {
      ...blankQuery("read"),
      read_traversal: mode,
      match: [clause(graphLabel, [node])],
    };
  }

  const network = flat.match(/^MATCH \(n:([A-Za-z_][A-Za-z0-9_]*)\)-\[r\*\]-\(n\) RETURN \*$/i);
  if (network) {
    const label = network[1].toUpperCase();
    if (label !== "STEP" && label !== "SCHEMA" && label !== "INSTANCE") return null;
    const graphLabel: GraphNodeLabel = label === "STEP" ? "STEP" : label === "SCHEMA" ? "SCHEMA" : "INSTANCE";
    const node = blankNode("n");
    node.labels = [graphLabel];
    return { ...blankQuery("read"), match: [clause(graphLabel, [node])] };
  }
  return null;
}

function parseMatchClause(body: string, optional: boolean, defined: Set<string>): MatchClause {
  const patterns = splitTop(body)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ path: parsePattern(part, defined) }));
  if (!patterns.length) throw new CypherShapeError("match");
  const label = clauseLabel(patterns);
  return { label, optional, patterns };
}

function parsePattern(src: string, defined: Set<string>): PathElement[] {
  const path: PathElement[] = [];
  let i = 0;
  while (i < src.length) {
    i = skipSpace(src, i);
    if (i >= src.length) break;
    const ch = src[i];
    if (ch === "(") {
      const parsed = parseNode(src, i, defined);
      path.push(parsed.element);
      i = parsed.next;
      continue;
    }
    if (ch === "-" || ch === "<") {
      const parsed = parseRelationship(src, i, defined);
      path.push(parsed.element);
      i = parsed.next;
      continue;
    }
    throw new CypherShapeError("pattern");
  }
  if (!path.length || path[0].kind !== "node") throw new CypherShapeError("pattern");
  if (path[path.length - 1].kind !== "node") throw new CypherShapeError("pattern");
  return path;
}

function parseNode(
  src: string,
  open: number,
  defined: Set<string>
): { element: PathElement; next: number } {
  const close = findCloser(src, open, "(", ")");
  const inner = src.slice(open + 1, close);
  const matched = inner.match(
    /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*)?((?::\s*(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*))*)\s*(\{[\s\S]*\})?\s*$/
  );
  if (!matched) throw new CypherShapeError("node");
  const labelNames = [...(matched[2] || "").matchAll(/:\s*(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/g)].map(
    (label) => label[1] || label[2]
  );
  const fields = matched[3] ? parsePropertyMap(matched[3]) : emptyFields();
  const requested = matched[1];
  const variable = requested || freshName("n", defined);
  const reference = defined.has(variable);
  if (!reference) defined.add(variable);
  const node: NodePattern = reference
    ? { variable, alias_mode: "reference", properties: [] }
    : nodeFromLabels(variable, labelNames, fields);
  return { element: { kind: "node", node }, next: close + 1 };
}

function parseRelationship(
  src: string,
  start: number,
  defined: Set<string>
): { element: PathElement; next: number } {
  let i = start;
  let incoming = false;
  if (src[i] === "<") {
    incoming = true;
    i += 1;
  }
  if (src[i] !== "-") throw new CypherShapeError("relationship");
  while (src[i] === "-") i += 1;
  let inner = "";
  if (src[i] === "[") {
    const close = findCloser(src, i, "[", "]");
    inner = src.slice(i + 1, close);
    i = close + 1;
    while (src[i] === "-") i += 1;
  }
  const outgoing = src[i] === ">";
  if (outgoing) i += 1;
  if (incoming === outgoing) throw new CypherShapeError("direction");
  const matched = inner.match(
    /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*)?(?::\s*(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*)))?\s*(\*(?:\s*\d+)?(?:\s*\.\.\s*\d*)?)?\s*(\{[\s\S]*\})?\s*$/
  );
  if (!matched) throw new CypherShapeError("relationship");
  const fields = matched[5] ? parsePropertyMap(matched[5]) : emptyFields();
  const requested = matched[1];
  const variable = requested || freshName("r", defined);
  const reference = Boolean(requested && defined.has(variable));
  if (!reference) defined.add(variable);
  const relationship: RelationshipPattern = reference
    ? {
        variable,
        alias_mode: "reference",
        type: "POINTS_TO",
        direction: incoming ? "incoming" : "outgoing",
        properties: [],
      }
    : {
        variable,
        alias_mode: "define",
        type: matched[2] || matched[3] || "POINTS_TO",
        direction: incoming ? "incoming" : "outgoing",
        properties: fields.properties,
        condition_type: fields.conditionType || "null",
      };
  if (!reference && fields.attributive) relationship.attributive_label = fields.attributive;
  if (!reference && fields.condition) relationship.condition = fields.condition;
  const length = parseLength(matched[4]);
  if (!reference && length) relationship.length = length;
  if (!reference && fields.idLiteral !== undefined) {
    relationship.id_binding = { key: "id", value: fields.idLiteral };
  }
  if (!reference && fields.idParam) {
    relationship.id_binding = { key: "id", value: `$${fields.idParam}`, parameter: fields.idParam };
  }
  return { element: { kind: "relationship", relationship }, next: i };
}

interface PropertyFields {
  properties: PropertyBinding[];
  attributive?: string;
  idLiteral?: unknown;
  idParam?: string;
  condition?: string;
  conditionType?: ConditionType;
}

function emptyFields(): PropertyFields {
  return { properties: [] };
}

function parsePropertyMap(raw: string): PropertyFields {
  const body = raw.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) throw new CypherShapeError("properties");
  const inner = body.slice(1, -1).trim();
  const fields = emptyFields();
  if (!inner) return fields;
  for (const part of splitTop(inner)) {
    const colon = topLevelColon(part);
    if (colon < 0) throw new CypherShapeError("properties");
    const key = unquoteKey(part.slice(0, colon).trim());
    const value = parseAtom(part.slice(colon + 1).trim());
    if (!key) throw new CypherShapeError("properties");
    if (key === "attributive_label") {
      if (value.kind !== "literal" || typeof value.value !== "string") {
        if (value.kind === "param") fields.attributive = `$${value.name}`;
        else throw new CypherShapeError("attributive_label");
      } else {
        fields.attributive = value.value;
      }
      continue;
    }
    if (key === "id") {
      if (value.kind === "param") fields.idParam = value.name;
      else fields.idLiteral = value.value;
      continue;
    }
    if (key === "condition" && value.kind === "literal") {
      fields.condition = String(value.value);
    }
    if (key === "condition_type" && value.kind === "literal") {
      const conditionType = String(value.value);
      if (CONDITION_TYPES.has(conditionType as ConditionType)) {
        fields.conditionType = conditionType as ConditionType;
        continue;
      }
    }
    fields.properties.push(
      value.kind === "param" ? { key, parameter: value.name } : { key, value: value.value }
    );
  }
  return fields;
}

function nodeFromLabels(variable: string, labelNames: string[], fields: PropertyFields): NodePattern {
  const graph = labelNames
    .map((name) => name.toUpperCase())
    .find((name): name is GraphNodeLabel => GRAPH_LABELS.has(name as GraphNodeLabel));
  const custom = labelNames.find((name) => !GRAPH_LABELS.has(name.toUpperCase() as GraphNodeLabel));
  const node: NodePattern = {
    variable,
    alias_mode: "define",
    properties: fields.properties,
  };
  if (graph) node.labels = [graph];
  else if (custom) node.labels = ["INSTANCE"];
  if (fields.attributive) node.attributive_label = fields.attributive;
  else if (custom) node.attributive_label = custom;
  if (fields.idLiteral !== undefined) node.id_binding = { key: "id", value: fields.idLiteral };
  if (fields.idParam) node.id_binding = { key: "id", value: `$${fields.idParam}`, parameter: fields.idParam };
  return node;
}

function parseReturn(body: string): { distinct: boolean; items: ReturnItem[] } {
  let text = body.trim();
  let distinct = false;
  if (/^DISTINCT\b/i.test(text)) {
    distinct = true;
    text = text.replace(/^DISTINCT\b/i, "").trim();
  }
  if (!text) throw new CypherShapeError("return");
  if (text === "*") return { distinct, items: [] };
  const items = splitTop(text).map((part) => splitAlias(part.trim())).filter((item) => item.expression);
  if (!items.length) throw new CypherShapeError("return");
  return { distinct, items };
}

function splitAlias(projection: string): ReturnItem {
  let depth = 0;
  let quote: string | null = null;
  let aliasAt = -1;
  for (let i = 0; i < projection.length; i += 1) {
    const ch = projection[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && keywordEnd(projection, i, "AS") >= 0) aliasAt = i;
  }
  if (aliasAt < 0) return { expression: projection.trim() };
  const alias = projection.slice(keywordEnd(projection, aliasAt, "AS")).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new CypherShapeError("alias");
  return { expression: projection.slice(0, aliasAt).trim(), alias };
}

function parseOrder(body: string): OrderByItem[] {
  const items = splitTop(body).map((part) => part.trim()).filter(Boolean);
  if (!items.length) throw new CypherShapeError("order");
  return items.map((part) => {
    let text = part;
    let nullOrder: OrderByItem["null_order"];
    const nulls = text.match(/\s+(NULLS\s+FIRST|NULLS\s+LAST)\s*$/i);
    if (nulls && nulls.index !== undefined) {
      nullOrder = nulls[1].toUpperCase() as OrderByItem["null_order"];
      text = text.slice(0, nulls.index).trim();
    }
    let direction: "ASC" | "DESC" = "ASC";
    const dir = text.match(/\s+(ASC|DESC)\s*$/i);
    if (dir && dir.index !== undefined) {
      direction = dir[1].toUpperCase() as "ASC" | "DESC";
      text = text.slice(0, dir.index).trim();
    }
    if (!text) throw new CypherShapeError("order");
    return nullOrder
      ? { expression: text, direction, null_order: nullOrder }
      : { expression: text, direction };
  });
}

function parseLiteralOrParameter(body: string): LiteralOrParameter {
  const text = body.trim();
  const param = text.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (param) return { parameter: param[1] };
  if (/^\d+$/.test(text)) return { value: Number.parseInt(text, 10) };
  throw new CypherShapeError("limit");
}

function parseUnwind(body: string): UnwindClause {
  const matched = body.trim().match(/^\[([\s\S]*)\]\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
  if (!matched) throw new CypherShapeError("unwind");
  const items = splitTop(matched[1]).map((part) => part.trim()).filter(Boolean);
  if (items.length < 2) throw new CypherShapeError("unwind");
  return { alias: matched[2], items: items.map((expression) => ({ expression })) };
}

function parseLength(star: string | undefined): RelationshipLength | undefined {
  if (!star) return undefined;
  const matched = star.match(/^\*\s*(\d+)?\s*(\.\.\s*(\d+)?)?$/);
  if (!matched) throw new CypherShapeError("length");
  if (matched[2]) {
    const min = matched[1] ? Number(matched[1]) : 1;
    return matched[3] ? { min, max: Number(matched[3]) } : { min };
  }
  if (matched[1]) {
    const exact = Number(matched[1]);
    return { min: exact, max: exact };
  }
  return { min: 1 };
}

type Atom = { kind: "literal"; value: unknown } | { kind: "param"; name: string };

function parseAtom(src: string): Atom {
  const text = src.trim();
  if (!text) throw new CypherShapeError("value");
  if (text[0] === "'" || text[0] === '"') {
    const read = readString(text, 0);
    if (text.slice(read.next).trim()) throw new CypherShapeError("value");
    return { kind: "literal", value: read.value };
  }
  const param = text.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (text[0] === "$") {
    if (!param) throw new CypherShapeError("param");
    return { kind: "param", name: param[1] };
  }
  if (/^-?\d+$/.test(text)) return { kind: "literal", value: Number.parseInt(text, 10) };
  if (/^-?\d+\.\d+$/.test(text)) return { kind: "literal", value: Number(text) };
  const lower = text.toLowerCase();
  if (lower === "true") return { kind: "literal", value: true };
  if (lower === "false") return { kind: "literal", value: false };
  if (lower === "null") return { kind: "literal", value: null };
  throw new CypherShapeError("value");
}

function resolveOperation(
  explicit: string | null | undefined,
  clauses: { kind: string }[]
): Operation {
  const inferred: Operation = clauses.some((clause) => clause.kind === "delete" || clause.kind === "detach_delete")
    ? "delete"
    : clauses.some((clause) => clause.kind === "set")
      ? "update"
      : clauses.some((clause) => clause.kind === "create" || clause.kind === "merge")
        ? "create"
        : "read";
  const named = (explicit || "").trim().toLowerCase();
  if (named !== "create" && named !== "read" && named !== "update" && named !== "delete") return inferred;
  if (inferred === "read") return named;
  return inferred;
}

function statementsOf(cypher: string | string[] | null | undefined): string[] {
  const pieces = typeof cypher === "string" ? [cypher] : Array.isArray(cypher) ? cypher : [];
  const statements: string[] = [];
  for (const piece of pieces) {
    for (const statement of splitStatements(stripComments(String(piece ?? "")))) {
      if (!/^\s*CREATE\s+INDEX\b/i.test(statement)) statements.push(statement);
    }
  }
  return statements;
}

function splitClauses(src: string): { kind: string; body: string }[] {
  const hits: { kind: string; start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < src.length) {
    const found = nextKeyword(src, cursor, CLAUSE_KEYWORDS);
    if (!found) break;
    hits.push(found);
    cursor = found.end;
  }
  if (!hits.length) throw new CypherShapeError("empty");
  if (src.slice(0, hits[0].start).trim()) throw new CypherShapeError("prologue");
  return hits.map((hit, index) => ({
    kind: hit.kind,
    body: src.slice(hit.end, index + 1 < hits.length ? hits[index + 1].start : src.length).trim(),
  }));
}

function hasBlockingKeyword(src: string): boolean {
  return nextKeyword(src, 0, BLOCKING_PHRASES.map((phrase) => ({ kind: phrase, phrase }))) !== null;
}

function nextKeyword(
  src: string,
  from: number,
  keywords: { kind: string; phrase: string }[]
): { kind: string; start: number; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    for (const keyword of keywords) {
      const end = keywordEnd(src, i, keyword.phrase);
      if (end >= 0) return { kind: keyword.kind, start: i, end };
    }
  }
  return null;
}

/** End index after `phrase` when it matches at `i` as a whole word, else -1. */
function keywordEnd(src: string, i: number, phrase: string): number {
  if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1])) return -1;
  const words = phrase.split(/\s+/);
  let j = i;
  for (let w = 0; w < words.length; w += 1) {
    const word = words[w];
    if (src.slice(j, j + word.length).toLowerCase() !== word.toLowerCase()) return -1;
    j += word.length;
    if (w < words.length - 1) {
      if (!/\s/.test(src[j] || "")) return -1;
      while (/\s/.test(src[j] || "")) j += 1;
    }
  }
  if (j < src.length && /[A-Za-z0-9_]/.test(src[j])) return -1;
  return j;
}

function splitStatements(src: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitTop(src: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function topLevelColon(src: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function findCloser(src: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new CypherShapeError("unclosed");
}

function readString(src: string, i: number): { value: string; next: number } {
  const quote = src[i];
  let value = "";
  for (let j = i + 1; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "\\") {
      const next = src[j + 1];
      if (next === undefined) throw new CypherShapeError("string");
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      j += 1;
      continue;
    }
    if (ch === quote) return { value, next: j + 1 };
    value += ch;
  }
  throw new CypherShapeError("string");
}

function unquoteKey(key: string): string {
  if (key.startsWith("`") && key.endsWith("`") && key.length >= 2) return key.slice(1, -1).replace(/``/g, "`");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new CypherShapeError("key");
  return key;
}

function unquoteAttributive(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (text[0] === "$") return text;
  if (text[0] === "'" || text[0] === '"') return readString(text, 0).value;
  return text;
}

function collectParameters(stored: unknown, text: string): Parameter[] {
  const byName = new Map<string, Parameter>();
  if (Array.isArray(stored)) {
    for (const row of stored) {
      if (!row || typeof row !== "object") continue;
      const name = String((row as { name?: unknown }).name ?? "").trim();
      if (!name) continue;
      byName.set(name, row as Parameter);
    }
  }
  const blanked = blankQuotes(text).replace(/\$secret\.[A-Za-z_][A-Za-z0-9_]*/g, " ");
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blanked))) {
    if (!byName.has(match[1])) {
      byName.set(match[1], { name: match[1], data_type: "string", value: "", is_required: false });
    }
  }
  return [...byName.values()];
}

function blankQuotes(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += " ";
      if (ch === "\\") {
        out += " ";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function clauseLabel(patterns: { path: PathElement[] }[]): GraphNodeLabel {
  for (const pattern of patterns) {
    for (const element of pattern.path) {
      if (element.kind === "node" && element.node.labels && element.node.labels[0]) return element.node.labels[0];
    }
  }
  return "INSTANCE";
}

function clause(label: GraphNodeLabel, nodes: NodePattern[]): MatchClause {
  return {
    label,
    optional: false,
    patterns: [{ path: nodes.map((node) => ({ kind: "node", node })) }],
  };
}

function blankNode(variable: string): NodePattern {
  return { variable, alias_mode: "define", properties: [] };
}

function blankQuery(operation: Operation): QueryObject {
  return {
    id: "query",
    name: "",
    operation,
    parameters: [],
    match: [],
    return: { distinct: false, items: [] },
    allow_duplicates: false,
    hide_duplicates: false,
  };
}

function freshName(prefix: "n" | "r", defined: Set<string>): string {
  let i = 1;
  while (defined.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}
