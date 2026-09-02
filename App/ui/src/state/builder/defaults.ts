/**
 * Builder defaults.
 *
 * The QueryObject factories live in @pona-flow/authoring so the MCP server can build the
 * same shapes headlessly; they are re-exported here so builder code keeps its existing
 * import site. `initialBuilderState` stays in the UI: it reads the operator's last
 * operation/label out of localStorage, which has no meaning in Node.
 */

import { newMatchClause, newQuery } from "@pona-flow/authoring";
import uiPersistence from "../../services/uiPersistence";
import type { BuilderState } from "./types";

export {
  emptyWhereGroup,
  localId,
  newMatchClause,
  newNodePattern,
  newParameter,
  newPattern,
  newPropertyBinding,
  newQuery,
  newRelationshipPattern,
  newReturnItem,
  newUnwindItem,
  newSchemaProperty,
  newSchematicProperties,
  newWhereFilter,
  nextNodeVariable,
  nextRelVariable,
} from "@pona-flow/authoring";

export function initialBuilderState(spaceId: string | null = null): BuilderState {
  // Restore the operator's last operation/label so a refresh (or space switch) lands them
  // back where they were instead of resetting to read/STEP.
  const operation = uiPersistence.getOperation() ?? "read";
  const label = uiPersistence.getLabel() ?? "STEP";
  const runtimeEnabled = label === "SCHEMA" || label === "INSTANCE" ? false : true;
  return {
    spaceId,
    runtimeEnabled,
    query: { ...newQuery(operation), match: [newMatchClause(label)] },
    checks: {},
    modal: { kind: null, context: null },
    savedQueries: [],
    spaceLabels: [],
    spaceGroups: [],
    spaceDevMode: false,
    spaceDefaultEndpoint: "",
    regexPatterns: [],
    run: { status: "idle", error: null, result: null },
    status: { message: "Editing", kind: "info" },
    dataVersion: 0,
    selectedMatchElement: null,
    matchPositions: {},
    editOperation: null,
    editSequence: null,
    lockedStepRelationship: false
  };
}
