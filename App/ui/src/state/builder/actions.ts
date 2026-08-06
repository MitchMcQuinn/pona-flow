import type {
  FieldCheck,
  GraphNodeLabel,
  MatchNodePositions,
  ModalState,
  Operation,
  QueryObject,
  RunResult,
  SelectedMatchElement
} from "./types";

export type BuilderAction =
  | { type: "RESET"; spaceId: string | null }
  | { type: "SET_SPACE"; spaceId: string | null }
  | { type: "SET_OPERATION"; operation: Operation }
  | { type: "SET_LABEL"; label: GraphNodeLabel }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_RUNTIME_ENABLED"; value: boolean }
  // Generic immutable edit of the query tree. Updater must be pure.
  | { type: "UPDATE_QUERY"; updater: (query: QueryObject) => QueryObject }
  | { type: "SET_CHECK"; key: string; check: FieldCheck }
  | { type: "CLEAR_CHECKS"; prefix?: string }
  | { type: "OPEN_MODAL"; modal: ModalState }
  | { type: "CLOSE_MODAL" }
  | {
      type: "SET_SAVED_QUERIES";
      rows: Array<{
        id: string;
        name: string;
        operation: string;
        kind: string;
        runtimeEnabled: boolean;
        suspended: boolean;
      }>;
    }
  | { type: "SET_SPACE_LABELS"; labels: string[] }
  | { type: "SET_SPACE_GROUPS"; groups: string[] }
  | { type: "SET_SPACE_DEV_MODE"; value: boolean }
  | { type: "SET_SPACE_DEFAULT_ENDPOINT"; endpoint: string }
  | { type: "SET_REGEX_PATTERNS"; patterns: Array<{ name: string; regex: string | null }> }
  | { type: "SET_STATUS"; message: string; kind: "info" | "ok" | "error" }
  | { type: "RUN_STARTED" }
  | { type: "RUN_SUCCEEDED"; result: RunResult }
  | { type: "RUN_FAILED"; error: string }
  | { type: "RESET_BUILDER" }
  | { type: "REGENERATE_QUERY_ID" }
  | { type: "DATA_CHANGED" }
  | { type: "SELECT_MATCH_ELEMENT"; element: SelectedMatchElement | null }
  | { type: "SET_MATCH_POSITIONS"; positions: MatchNodePositions }
  // Edit-operation mode: load a saved operation's builder snapshot into a locked edit view.
  | {
      type: "ENTER_EDIT_OPERATION";
      queryId: string;
      query: QueryObject;
      runtimeEnabled: boolean;
      matchPositions?: MatchNodePositions;
    }
  | { type: "EXIT_EDIT_OPERATION" }
  // Edit-relationship mode: open the update-STEP flow locked to a single POINTS_TO relationship
  // (the caller patches the `(start)-[rel]->(end)` path into the fresh form afterwards).
  | { type: "ENTER_EDIT_STEP_RELATIONSHIP" }
  // Edit-sequence mode: load a saved sequence's builder snapshot into the create-sequence builder.
  | {
      type: "ENTER_EDIT_SEQUENCE";
      queryId: string;
      query: QueryObject;
      runtimeEnabled: boolean;
      matchPositions?: MatchNodePositions;
    }
  | { type: "EXIT_EDIT_SEQUENCE" };
