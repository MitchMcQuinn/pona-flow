import { useBuilder } from "../../../state/builder/BuilderContext";
import {
  projectMatchToGraph,
  removeGraphEdge,
  removeGraphNode
} from "../../../state/builder/matchGraph";
import type { GraphNodeLabel, Operation } from "../../../state/builder/types";
import { NodePathEntry } from "./NodePathEntry";
import { RelPathEntry } from "./RelPathEntry";

interface ElementConfigProps {
  clauseIndex: number;
  label: GraphNodeLabel;
  operation: Operation;
}

/**
 * Configuration card for the element currently selected on the graph canvas. It locates
 * the selected entity's *defining* path occurrence (by variable) and reuses the existing
 * node/relationship entry components, with the alias picker hidden (aliases are implicit).
 */
export function ElementConfig({ clauseIndex, label, operation }: ElementConfigProps) {
  const { state, patchQuery, dispatch } = useBuilder();
  const selected = state.selectedMatchElement;
  if (!selected) {
    return (
      <div className="matchElementConfig matchElementConfigEmpty">
        Select a node or relationship to edit it.
      </div>
    );
  }

  const graph = projectMatchToGraph(state.query, clauseIndex);
  const pattern = (address: { patternIndex: number; pathIndex: number }) =>
    state.query.match[clauseIndex]?.patterns[address.patternIndex]?.path[address.pathIndex];

  if (selected.kind === "node") {
    const gn = graph.nodes.find((n) => n.variable === selected.variable);
    const element = gn ? pattern(gn.address) : undefined;
    if (!gn || element?.kind !== "node") {
      return (
        <div className="matchElementConfig matchElementConfigEmpty">
          Select a node or relationship to edit it.
        </div>
      );
    }
    function removeNode() {
      patchQuery(removeGraphNode(clauseIndex, selected!.variable));
      dispatch({ type: "SELECT_MATCH_ELEMENT", element: null });
    }
    return (
      <div className="matchElementConfig">
        <div className="matchElementConfigHead">
          <label className="matchPaneTitle">node config</label>
          <button type="button" className="builderTinyBtn builderDanger" onClick={removeNode}>
            Remove node
          </button>
        </div>
        <NodePathEntry
          clauseIndex={clauseIndex}
          patternIndex={gn.address.patternIndex}
          pathIndex={gn.address.pathIndex}
          node={element.node}
          label={label}
          operation={operation}
          graphMode
        />
      </div>
    );
  }

  const ge = graph.edges.find((e) => e.variable === selected.variable);
  const relElement = ge ? pattern(ge.address) : undefined;
  if (!ge || relElement?.kind !== "relationship") {
    return (
      <div className="matchElementConfig matchElementConfigEmpty">
        Select a node or relationship to edit it.
      </div>
    );
  }
  function removeRelationship() {
    patchQuery(removeGraphEdge(clauseIndex, selected!.variable));
    dispatch({ type: "SELECT_MATCH_ELEMENT", element: null });
  }
  return (
    <div className="matchElementConfig">
      <div className="matchElementConfigHead">
        <label className="matchPaneTitle">relationship config</label>
        <button type="button" className="builderTinyBtn builderDanger" onClick={removeRelationship}>
          Remove relationship
        </button>
      </div>
      <RelPathEntry
        clauseIndex={clauseIndex}
        patternIndex={ge.address.patternIndex}
        pathIndex={ge.address.pathIndex}
        relationship={relElement.relationship}
        operation={operation}
        label={label}
        graphMode
      />
    </div>
  );
}
