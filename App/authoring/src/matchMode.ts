import { extractExactParameterRef } from "./parameterRefs.js";
import type { GraphNodeLabel, GraphPattern, NodePattern, Operation, QueryObject } from "./types.js";

export function isMatchOperation(operation: Operation): boolean {
  return operation === "read" || operation === "update" || operation === "delete";
}

/**
 * INSTANCE create and SCHEMA/INSTANCE match extend only along existing SCHEMA outgoing edges.
 * SCHEMA create defines new POINTS_TO hops in the package and is not limited to graph edges.
 */
export function schemaDrivenHopClause(label: GraphNodeLabel, operation: Operation): boolean {
  return (
    (label === "INSTANCE" || label === "SCHEMA") &&
    (operation === "create" || isMatchOperation(operation))
  );
}

/**
 * Whether the match-graph connect handle may drop back onto the same node (self-relationship).
 * Supported when defining patterns (e.g. SCHEMA create); read INSTANCE/SCHEMA match only
 * traverses existing outgoing edges and cannot express self-loops in the composer.
 */
export function allowMatchGraphSelfRelationship(
  label: GraphNodeLabel,
  operation: Operation
): boolean {
  return !(operation === "read" && (label === "INSTANCE" || label === "SCHEMA"));
}

/** True when +hop is hidden unless the trailing node has registered outgoing edges in the graph. */
export function hopGatedByGraphOutgoing(label: GraphNodeLabel, operation: Operation): boolean {
  if (label === "SCHEMA" && operation === "create") return false;
  return (
    schemaDrivenHopClause(label, operation) ||
    (label === "STEP" && isMatchOperation(operation))
  );
}

export function lastNodeAttributiveLabelInPattern(pattern: GraphPattern): string {
  for (let i = pattern.path.length - 1; i >= 0; i -= 1) {
    const el = pattern.path[i];
    if (el.kind === "node") {
      return (el.node.attributive_label ?? "").trim();
    }
  }
  return "";
}

/** Node label used to populate the attributive_label picker (INSTANCE → SCHEMA). */
export function matchPickerNodeLabel(clauseLabel: GraphNodeLabel): GraphNodeLabel {
  return clauseLabel === "INSTANCE" ? "SCHEMA" : clauseLabel;
}

/** Query-level parameters card (CREATE only, except STEP/SCHEMA/INSTANCE use inline params). */
export function showParametersSection(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  if (isMatchOperation(operation)) return false;
  if (
    operation === "create" &&
    (clauseLabel === "STEP" || clauseLabel === "SCHEMA" || clauseLabel === "INSTANCE")
  ) {
    return false;
  }
  return true;
}

/** OPTIONAL MATCH toggles apply only after the first clause (Neo4j + composer rules). */
export function showMatchOptionalControls(matchClauseCount: number, operation: Operation): boolean {
  return isMatchOperation(operation) && matchClauseCount > 1;
}

/**
 * Per-hop OPTIONAL MATCH: a read SCHEMA/INSTANCE relationship may be marked optional so
 * anchor nodes without the hop still return. Read STEP is excluded — a sequence needs a
 * single concrete entry point, so its match path never splits into optional segments.
 */
export function supportsOptionalHop(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  return operation === "read" && (clauseLabel === "SCHEMA" || clauseLabel === "INSTANCE");
}

/**
 * Match hops (read/update/delete SCHEMA/INSTANCE) may traverse an edge against its
 * schema-defined direction (`direction: "incoming"` on the relationship), so the hop
 * picker also offers edges that point AT the preceding node — e.g. hopping from VALUE
 * to PILLAR across PILLAR-[HAS_MANY]->VALUE. Create flows stay outgoing-only: creation
 * writes edges in the schema's defined direction.
 */
export function supportsIncomingHop(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  return (
    isMatchOperation(operation) && (clauseLabel === "SCHEMA" || clauseLabel === "INSTANCE")
  );
}

/**
 * Update SCHEMA / STEP edit only the per-space ``entities`` config (payload), never
 * the graph: no WHERE/SET/RETURN clauses, no Cypher on run — just an SQLite UPDATE
 * of the selected node/relationship's payload. Updating INSTANCE keeps the regular
 * MATCH…SET graph flow.
 */
export function isEntityConfigUpdate(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  return operation === "update" && (clauseLabel === "STEP" || clauseLabel === "SCHEMA");
}

/**
 * STEP / SCHEMA patterns carry no filterable graph properties — all of their data lives
 * in the per-space ``entities`` table, so they are fully identified by attributive_label.
 * For read and delete we therefore hide the WHERE card from the MATCH clause elements.
 * (Update STEP/SCHEMA is handled separately by ``isEntityConfigUpdate``.)
 */
export function isLabelOnlyMatch(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  return (
    (operation === "read" || operation === "delete") &&
    (clauseLabel === "STEP" || clauseLabel === "SCHEMA")
  );
}

/**
 * Delete STEP / SCHEMA: in addition to hiding the WHERE card (see ``isLabelOnlyMatch``),
 * the DELETE card is hidden and the user is assumed to intend a DETACH DELETE of every
 * node/relationship in the MATCH clause (composed automatically in
 * ``normalizeForCompose``).
 */
export function isLabelOnlyDelete(
  operation: Operation,
  clauseLabel: GraphNodeLabel | undefined
): boolean {
  return operation === "delete" && (clauseLabel === "STEP" || clauseLabel === "SCHEMA");
}

/** A new STEP node with a custom HTTP template (endpoint/body), not an operation reference. */
function isCustomEndpointNode(node: NodePattern): boolean {
  const sp = node.sequencial_properties;
  if (!sp) return false;
  if (sp.query_id && String(sp.query_id).trim()) return false;
  const hasResponseParameter = (sp.response_parameters ?? []).some(
    (rp) => String(rp.property_path ?? "").trim() || String(rp.parameter ?? "").trim()
  );
  return (
    Boolean(String(sp.endpoint ?? "").trim()) ||
    sp.body !== undefined ||
    hasResponseParameter
  );
}

/**
 * A node's identity (attributive_label + graph id) is concrete — not a runtime
 * ``$parameter`` — so it can be MERGEd into the graph/entities at create time.
 */
function hasLiteralIdentity(node: NodePattern): boolean {
  if (extractExactParameterRef(String(node.attributive_label ?? ""))) return false;
  if (node.id_binding?.parameter) return false;
  const idValue = node.id_binding?.value;
  if (typeof idValue === "string" && extractExactParameterRef(idValue)) return false;
  return true;
}

/** Every node the query CREATEs (new nodes; existing references are matched, not written). */
function createdNodes(query: QueryObject): NodePattern[] {
  const nodes: NodePattern[] = [];
  query.match.forEach((clause) => {
    clause.patterns.forEach((pattern) => {
      pattern.path.forEach((el) => {
        if (el.kind === "node" && el.node.node_source !== "existing") nodes.push(el.node);
      });
    });
  });
  return nodes;
}

/**
 * True for a create STEP whose new node(s) are custom HTTP endpoints with literal
 * identities. Such a query may Run even though it "uses parameters": the ``$param``
 * tokens in the endpoint/body/headers are stored verbatim in the entity payload and
 * substituted at sequence runtime by the executor (mirrors ``isEntityConfigUpdate``).
 * Requiring a literal attributive_label/id guarantees the graph MERGE stays param-free
 * so the endpoint entity is always materialized with a concrete identity.
 */
export function isRunnableEndpointStepCreate(query: QueryObject): boolean {
  if (query.operation !== "create" || query.match[0]?.label !== "STEP") return false;
  const nodes = createdNodes(query);
  if (nodes.length === 0) return false;
  if (!nodes.some(isCustomEndpointNode)) return false;
  return nodes.every(hasLiteralIdentity);
}
