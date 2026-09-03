import type { RunResult } from "./builder/types";
import type { AppState, SequenceDefinition, StepGraphNode, StepGraphRelationship } from "./types";

function findInspectableElement(
  definition: SequenceDefinition | null,
  selected: { kind: "node" | "relationship"; id: string }
): StepGraphNode | StepGraphRelationship | null {
  if (!definition) return null;
  if (selected.kind === "node") {
    return definition.stepGraph.nodes.find((node) => node.id === selected.id) ?? null;
  }
  return definition.stepGraph.relationships.find((rel) => rel.id === selected.id) ?? null;
}

function runResultHasContent(result: RunResult): boolean {
  if (result.kind === "summary") {
    const counters = (result.summary?.counters as Record<string, unknown>) ?? {};
    return Object.keys(counters).length > 0;
  }
  if (result.kind === "response") return true;
  const hasGraph = (result.graph?.nodes.length ?? 0) > 0;
  const hasRows = (result.rows?.length ?? 0) > 0;
  return hasGraph || hasRows;
}

function shouldShowBuilderResult(state: AppState, builderResult?: RunResult | null): boolean {
  if (!builderResult || !runResultHasContent(builderResult)) return false;
  if (state.createSequence || state.createEvent || state.spacePanelOpen || state.localLlmsPanelOpen)
    return false;
  const mode = state.view.rightPanelMode;
  return mode !== "space" && mode !== "event" && mode !== "localLlms";
}

function selectedIsSingleStep(state: AppState): boolean {
  const id = state.nav.selectedSequenceId;
  if (!id) return false;
  return Boolean(state.nav.sequences.find((sequence) => sequence.id === id)?.singleStep);
}

export const selectors = {
  hasSequenceSelected: (state: AppState) => Boolean(state.nav.selectedSequenceId),
  showRunButton: (state: AppState) => Boolean(state.nav.selectedSequenceId),
  canRun: (state: AppState) =>
    Boolean(state.nav.selectedSequenceId) &&
    state.params.allValid &&
    state.run.status !== "running",
  rightPanelMode: (state: AppState) =>
    state.editor.selectedElement
      ? "inspect"
      : state.nav.selectedSequenceId
        ? "params"
        : "builder",
  hasVisualizationContent: (state: AppState, builderResult?: RunResult | null) => {
    if (shouldShowBuilderResult(state, builderResult)) return true;
    // One-step sequences have no chain to map, so hide the column until a run produces results.
    if (selectedIsSingleStep(state)) return false;
    if (state.sequence.error) return true;
    if (state.sequence.loading) return true;

    switch (state.view.visualMode) {
      case "empty":
        return false;
      case "audit_log":
        return true;
      case "design_graph": {
        if (state.nav.selectedSequenceId) return true;
        const definition = state.sequence.definition;
        if (!definition) return false;
        const { nodes, relationships } = definition.stepGraph;
        return nodes.length > 0 || relationships.length > 0;
      }
      case "result_graph":
        return Boolean(
          state.results.graphData &&
            ((state.results.graphData.nodes?.length ?? 0) > 0 ||
              (state.results.graphData.relationships?.length ?? 0) > 0)
        );
      case "result_table":
        return Boolean(
          state.results.tableData && (state.results.tableData.rows?.length ?? 0) > 0
        );
      default:
        return false;
    }
  },
  hasConfigContent: (state: AppState) => {
    const mode = state.view.rightPanelMode;

    if (mode === "builder") return true;

    if (mode === "params") {
      // The panel is shown whenever a sequence is selected: inputs are revealed progressively
      // as the run reaches each step, so an empty input schema is expected up front (the panel
      // still shows the response parameters and a hint about how inputs appear).
      return Boolean(state.nav.selectedSequenceId);
    }

    if (mode === "inspect") {
      const selected = state.editor.selectedElement;
      if (!selected) return false;
      const element = findInspectableElement(state.sequence.definition, selected);
      if (!element) return false;
      return Object.keys(element.payload ?? {}).length > 0;
    }

    return true;
  }
};
