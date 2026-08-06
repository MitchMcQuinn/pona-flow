import { useMemo } from "react";
import type { AppState, SequenceDefinition } from "../state/types";
import type { GraphPayload, RunResult } from "../state/builder/types";
import { GraphView } from "./results/GraphView";
import { ResultView } from "./results/ResultView";

function stepGraphToGraphPayload(stepGraph: SequenceDefinition["stepGraph"]): GraphPayload {
  return {
    nodes: stepGraph.nodes.map((node) => ({
      element_id: node.id,
      labels: ["STEP"],
      properties: {
        attributive_label: node.attributive_label,
        ...node.payload
      }
    })),
    relationships: stepGraph.relationships.map((rel) => ({
      element_id: rel.id,
      type: rel.type,
      start: rel.source,
      end: rel.target,
      properties: {
        attributive_label: rel.attributive_label,
        ...rel.payload
      }
    }))
  };
}

/** True when a result-graph entity carries the persisted out-of-sync marker (is_current=false). */
function isOutOfSync(properties: Record<string, unknown> | null | undefined): boolean {
  return !!properties && properties.is_current === false;
}

function nodeLabelSet(graph: RunResult["graph"]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of graph?.nodes ?? []) {
    map.set(node.element_id, new Set(node.labels));
  }
  return map;
}

/** INSTANCE data relationship (not a SCHEMA pattern edge between SCHEMA nodes). */
function isInstanceRelationship(
  rel: { start: string | null; end: string | null },
  labelsByNodeId: Map<string, Set<string>>
): boolean {
  if (!rel.start || !rel.end) return false;
  const startLabels = labelsByNodeId.get(rel.start);
  const endLabels = labelsByNodeId.get(rel.end);
  return !!startLabels?.has("INSTANCE") && !!endLabels?.has("INSTANCE");
}

/** Resolve graph node ids to highlight red. Combines two independent signals:
 * 1. Steps whose backing operation drifted from its SCHEMA (sequence suspension) — covers the
 *    design-graph (step-flow) and the read-query result graph (single-step sequences show the
 *    result graph, whose STEP nodes use different element_ids and usually lack query_id).
 * 2. Live INSTANCE nodes flagged out of sync via the persisted is_current=false marker. */
function computeAffectedNodeIds(
  definition: SequenceDefinition | null | undefined,
  builderResult: RunResult | null | undefined
): Set<string> | null {
  const ids = new Set<string>();
  const affectedOps = new Set(definition?.affectedQueryIds ?? []);
  // The backend resolves which STEP attributive_labels drift (independent of the step-flow
  // connected component, which is empty for single-step sequences). This is the reliable key for
  // the read-query result graph, whose STEP nodes carry attributive_label but no query_id.
  const affectedLabels = new Set(definition?.affectedStepLabels ?? []);

  // Design graph (step flow): match by the step's backing operation or its label.
  if (definition) {
    for (const node of definition.stepGraph.nodes) {
      const queryId = String(node.payload?.query_id ?? "").trim();
      const label = node.attributive_label.trim();
      if ((queryId && affectedOps.has(queryId)) || (label && affectedLabels.has(label))) {
        ids.add(node.id);
      }
    }
  }

  // Read-query result graph: match drifted STEP nodes by attributive_label (no query_id on these),
  // plus any node persisted as out of sync (is_current=false), regardless of suspension state.
  const resultNodes = builderResult?.graph?.nodes;
  if (resultNodes) {
    for (const node of resultNodes) {
      // Currency markers apply to INSTANCE data only, not SCHEMA pattern nodes.
      if (node.labels.includes("INSTANCE") && isOutOfSync(node.properties)) {
        ids.add(node.element_id);
        continue;
      }
      if (!node.labels.includes("STEP")) continue;
      const queryId = String(node.properties?.query_id ?? "").trim();
      const label = String(node.properties?.attributive_label ?? "").trim();
      if ((queryId && affectedOps.has(queryId)) || (label && affectedLabels.has(label))) {
        ids.add(node.element_id);
      }
    }
  }

  return ids.size > 0 ? ids : null;
}

/** Relationship ids to paint red: out-of-sync INSTANCE relationships (is_current=false). */
function computeAffectedRelationshipIds(
  builderResult: RunResult | null | undefined
): Set<string> | null {
  const graph = builderResult?.graph;
  const rels = graph?.relationships;
  if (!rels) return null;
  const labelsByNodeId = nodeLabelSet(graph);
  const ids = new Set<string>();
  for (const rel of rels) {
    if (!isInstanceRelationship(rel, labelsByNodeId)) continue;
    if (isOutOfSync(rel.properties)) ids.add(rel.element_id);
  }
  return ids.size > 0 ? ids : null;
}

interface VisualizationPanelProps {
  state: AppState;
  builderResult?: RunResult | null;
  /** True while the selected sequence's read query is still loading (holds a single loading state). */
  previewLoading?: boolean;
  onClickNode: (nodeId: string) => void;
  onClickRelationship: (relId: string) => void;
  /** Click handler for nodes in a displayed sequence/query result graph. */
  onResultNodeClick?: (nodeId: string) => void;
  /** Click handler for POINTS_TO relationships in a displayed sequence/query result graph. */
  onResultRelationshipClick?: (relId: string) => void;
}

export function VisualizationPanel({
  state,
  builderResult,
  previewLoading = false,
  onClickNode,
  onClickRelationship,
  onResultNodeClick,
  onResultRelationshipClick
}: VisualizationPanelProps) {
  const definition = state.sequence.definition;

  // Memoize the design-graph payload so its object identity is stable across re-renders (e.g. the
  // periodic Clerk token refresh); otherwise GraphView would see a "new" graph each render and
  // re-run its force layout, making the graph drift on its own.
  const designGraph = useMemo(
    () => (definition ? stepGraphToGraphPayload(definition.stepGraph) : null),
    [definition]
  );

  // Step nodes whose backing operation (payload.query_id) drifted from its SCHEMA — these are the
  // steps an author must re-save to lift the sequence's suspension, so we paint them red.
  const affectedNodeIds = useMemo(
    () => computeAffectedNodeIds(definition, builderResult),
    [definition, builderResult]
  );

  // Out-of-sync INSTANCE relationships (is_current=false) to paint red in the result graph.
  const affectedRelationshipIds = useMemo(
    () => computeAffectedRelationshipIds(builderResult),
    [builderResult]
  );

  const sequenceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const sequence of state.nav.sequences) map.set(sequence.id, sequence.label);
    return map;
  }, [state.nav.sequences]);

  const eventLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const trigger of state.events.items) map.set(trigger.id, trigger.name);
    return map;
  }, [state.events.items]);

  if (state.view.visualMode === "audit_log") {
    const { entries, loading, error } = state.auditLog;
    return (
      <section className="panel vizPanel">
        <div className="panel__body">
          <h2>Audit log</h2>
          <p className="muted">Read-only record of every sequence run (most recent first).</p>
          {loading ? <p className="muted">Loading audit log...</p> : null}
          {error ? <p className="errorText">{error}</p> : null}
          {!loading && !error && entries.length === 0 ? (
            <p className="muted">No sequence runs recorded yet.</p>
          ) : null}
          {!loading && !error && entries.length > 0 ? (
            <table className="auditLogTable">
              <thead>
                <tr>
                  <th>Run at (UTC)</th>
                  <th>Trigger</th>
                  <th>Sequence(s)</th>
                  <th>Event</th>
                  <th>Principal</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.runAt}</td>
                    <td>{entry.trigger}</td>
                    <td>
                      {entry.sequenceIds.length === 0
                        ? "—"
                        : entry.sequenceIds
                            .map((id) => sequenceLabels.get(id) ?? id)
                            .join(", ")}
                    </td>
                    <td>{entry.eventId ? eventLabels.get(entry.eventId) ?? entry.eventId : "—"}</td>
                    <td>{entry.principalEmail ?? entry.principalId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>
    );
  }

  // A selected sequence runs its stored read query into builderResult, but that query can
  // return nothing (e.g. a single-step sequence whose -[*]-> path has no downstream hops).
  // Only let the result view take over when it actually has content; otherwise fall through
  // to the design graph so the full sequence (from the step-flow) stays visible and clickable.
  const resultHasContent =
    !!builderResult &&
    (((builderResult.graph?.nodes.length ?? 0) > 0) ||
      ((builderResult.rows?.length ?? 0) > 0) ||
      builderResult.kind === "summary" ||
      builderResult.kind === "response");
  // The design graph (step flow) and the read-query result graph show the same flow, so the
  // definition (fast) loading before the read query (slow) would render the design graph and
  // then swap to the result graph. Treat the read query as part of the same loading window so
  // the panel goes loading -> final graph in one transition instead of flickering.
  const flowLoading = state.sequence.loading || previewLoading;
  const designGraphAvailable =
    state.view.visualMode === "design_graph" &&
    !!definition &&
    !!designGraph &&
    !flowLoading &&
    (designGraph.nodes.length > 0 || designGraph.relationships.length > 0);

  // Only take over the panel for graph/table content, or for a settled (non-loading) empty
  // result that has no design graph to fall back to.
  if (resultHasContent || (builderResult && !flowLoading && !designGraphAvailable)) {
    return (
      <section className="panel vizPanel">
        <div className="panel__body">
          <h2>Result</h2>
          <ResultView
            result={builderResult}
            onClickNode={onResultNodeClick}
            onClickRelationship={onResultRelationshipClick}
            affectedNodeIds={affectedNodeIds}
            affectedRelationshipIds={affectedRelationshipIds}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="panel vizPanel">
      <div className="panel__body">
        <h2>Visualization</h2>
        {state.view.visualMode === "empty" ? <p className="muted">Select a sequence to begin.</p> : null}
        {flowLoading ? <p className="muted">Loading step flow...</p> : null}
        {state.sequence.error ? <p className="errorText">{state.sequence.error}</p> : null}

      {state.view.visualMode === "design_graph" &&
      definition &&
      designGraph &&
      !flowLoading &&
      (designGraph.nodes.length > 0 || designGraph.relationships.length > 0) ? (
        <div className="designGraphView">
          <p className="muted">Design graph for {definition.label}</p>
          <GraphView
            graph={designGraph}
            onClickNode={onClickNode}
            onClickRelationship={onClickRelationship}
            highlightedRelationshipId={
              state.editor.selectedElement?.kind === "relationship"
                ? state.editor.selectedElement.id
                : null
            }
            affectedNodeIds={affectedNodeIds}
            affectedRelationshipIds={affectedRelationshipIds}
          />
        </div>
      ) : null}

      {state.view.visualMode === "design_graph" &&
      !flowLoading &&
      definition &&
      designGraph &&
      designGraph.nodes.length === 0 &&
      designGraph.relationships.length === 0 ? (
        <p className="muted">This sequence has no step graph to display.</p>
      ) : null}

      {state.view.visualMode === "result_graph" && state.results.graphData ? (
        <div>
          <p className="muted">Result graph</p>
          <pre>{JSON.stringify(state.results.graphData, null, 2)}</pre>
        </div>
      ) : null}

      {state.view.visualMode === "result_table" && state.results.tableData ? (
        <div>
          <p className="muted">Result table</p>
          <table>
            <thead>
              <tr>
                {state.results.tableData.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.results.tableData.rows.map((row, index) => (
                <tr key={index}>
                  {state.results?.tableData?.columns.map((column) => (
                    <td key={column}>{String(row[column] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      </div>
    </section>
  );
}
