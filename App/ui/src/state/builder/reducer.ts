import type { BuilderAction } from "./actions";
import { localId, newMatchClause, newQuery } from "./defaults";
import type { BuilderState, GraphNodeLabel, Operation, QueryObject } from "./types";

// Changing the operation or the label resets every form input to defaults,
// preserving only the query identity (id) and its name.
function freshForm(
  operation: Operation,
  label: GraphNodeLabel,
  id: string,
  name: string
): QueryObject {
  return { ...newQuery(operation), id, name, match: [newMatchClause(label)] };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case "RESET":
      return {
        ...state,
        spaceId: action.spaceId,
        query: newQuery("read"),
        checks: {},
        modal: { kind: null, context: null },
        run: { status: "idle", error: null, result: null },
        status: { message: "Editing", kind: "info" },
        selectedMatchElement: null,
        matchPositions: {},
        editOperation: null,
        editSequence: null,
        lockedStepRelationship: false
      };

    case "SET_SPACE":
      return {
        ...state,
        spaceId: action.spaceId,
        checks: {},
        spaceDefaultEndpoint: "",
        spaceGroups: [],
        spaceDevMode: false
      };

    case "SET_OPERATION": {
      const label = state.query.match[0]?.label ?? "STEP";
      return {
        ...state,
        query: freshForm(action.operation, label, state.query.id, state.query.name),
        checks: {},
        selectedMatchElement: null,
        matchPositions: {},
        editOperation: null,
        editSequence: null,
        lockedStepRelationship: false
      };
    }

    case "SET_LABEL": {
      const runtimeEnabled =
        action.label === "SCHEMA" || action.label === "INSTANCE" ? false : state.runtimeEnabled;
      return {
        ...state,
        runtimeEnabled,
        query: freshForm(state.query.operation, action.label, state.query.id, state.query.name),
        checks: {},
        selectedMatchElement: null,
        matchPositions: {},
        editOperation: null,
        editSequence: null,
        lockedStepRelationship: false
      };
    }

    case "SET_NAME":
      return { ...state, query: { ...state.query, name: action.name } };

    case "SET_RUNTIME_ENABLED":
      return { ...state, runtimeEnabled: action.value };

    case "UPDATE_QUERY":
      return { ...state, query: action.updater(state.query) };

    case "SET_CHECK":
      return { ...state, checks: { ...state.checks, [action.key]: action.check } };

    case "CLEAR_CHECKS": {
      if (!action.prefix) return { ...state, checks: {} };
      const next: BuilderState["checks"] = {};
      for (const [key, value] of Object.entries(state.checks)) {
        if (!key.startsWith(action.prefix)) next[key] = value;
      }
      return { ...state, checks: next };
    }

    case "OPEN_MODAL":
      return { ...state, modal: action.modal };

    case "CLOSE_MODAL":
      return { ...state, modal: { kind: null, context: null } };

    case "SET_SAVED_QUERIES":
      return { ...state, savedQueries: action.rows };

    case "SET_SPACE_LABELS":
      return { ...state, spaceLabels: action.labels };

    case "SET_SPACE_GROUPS":
      return { ...state, spaceGroups: action.groups };

    case "SET_SPACE_DEV_MODE":
      return { ...state, spaceDevMode: action.value };

    case "SET_SPACE_DEFAULT_ENDPOINT":
      return { ...state, spaceDefaultEndpoint: action.endpoint };

    case "SET_REGEX_PATTERNS":
      return { ...state, regexPatterns: action.patterns };

    case "SET_STATUS":
      return { ...state, status: { message: action.message, kind: action.kind } };

    case "RUN_STARTED":
      return { ...state, run: { status: "running", error: null, result: null } };

    case "RUN_SUCCEEDED":
      return { ...state, run: { status: "success", error: null, result: action.result } };

    case "RUN_FAILED":
      return { ...state, run: { status: "error", error: action.error, result: null } };

    case "RESET_BUILDER": {
      const op = state.query.operation;
      const label = state.query.match[0]?.label ?? "STEP";
      return {
        ...state,
        query: freshForm(op, label, localId("query"), ""),
        checks: {},
        modal: { kind: null, context: null },
        run: { status: "idle", error: null, result: null },
        status: { message: "Editing", kind: "info" },
        selectedMatchElement: null,
        matchPositions: {},
        editOperation: null,
        editSequence: null,
        lockedStepRelationship: false
      };
    }

    case "REGENERATE_QUERY_ID":
      // Swap in a fresh query id while preserving the rest of the form, so the next
      // "Create operation" saves a new catalog row instead of overwriting the one just saved.
      return { ...state, query: { ...state.query, id: localId("query") } };

    case "DATA_CHANGED":
      return { ...state, dataVersion: state.dataVersion + 1 };

    case "SELECT_MATCH_ELEMENT":
      return { ...state, selectedMatchElement: action.element };

    case "SET_MATCH_POSITIONS":
      return { ...state, matchPositions: action.positions };

    case "ENTER_EDIT_OPERATION":
      return {
        ...state,
        query: action.query,
        runtimeEnabled: action.runtimeEnabled,
        matchPositions: action.matchPositions ?? {},
        editOperation: { queryId: action.queryId },
        editSequence: null,
        lockedStepRelationship: false,
        checks: {},
        modal: { kind: null, context: null },
        run: { status: "idle", error: null, result: null },
        status: { message: "Editing operation", kind: "info" },
        selectedMatchElement: null
      };

    case "EXIT_EDIT_OPERATION":
      return { ...state, editOperation: null };

    case "ENTER_EDIT_STEP_RELATIONSHIP":
      // Open a fresh update-STEP form locked to a single relationship; the caller patches the
      // (start)-[rel]->(end) path in afterwards. Mirrors SET_OPERATION/SET_LABEL but sets the lock.
      return {
        ...state,
        query: freshForm("update", "STEP", state.query.id, state.query.name),
        checks: {},
        selectedMatchElement: null,
        matchPositions: {},
        editOperation: null,
        editSequence: null,
        lockedStepRelationship: true
      };

    case "ENTER_EDIT_SEQUENCE":
      return {
        ...state,
        query: action.query,
        runtimeEnabled: action.runtimeEnabled,
        matchPositions: action.matchPositions ?? {},
        editSequence: { queryId: action.queryId },
        editOperation: null,
        lockedStepRelationship: false,
        checks: {},
        modal: { kind: null, context: null },
        run: { status: "idle", error: null, result: null },
        status: { message: "Editing sequence", kind: "info" },
        selectedMatchElement: null
      };

    case "EXIT_EDIT_SEQUENCE":
      return { ...state, editSequence: null };

    default:
      return state;
  }
}
