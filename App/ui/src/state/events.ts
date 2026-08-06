import type {
  AuditEntry,
  EventSummary,
  GraphPayload,
  Me,
  ParameterSchema,
  ResponseParamSchema,
  SequenceDefinition,
  SequenceSummary,
  SpacePermissions,
  TablePayload
} from "./types";

export type AppEvent =
  | { type: "SPACE_SELECTED"; spaceId: string | null }
  | { type: "SEQUENCES_LOAD_STARTED" }
  | { type: "SEQUENCES_LOAD_SUCCEEDED"; sequences: SequenceSummary[] }
  | { type: "SEQUENCES_LOAD_FAILED"; error: string }
  | { type: "SEQUENCES_REORDERED"; sequences: SequenceSummary[] }
  | { type: "GROUPS_LOADED"; groups: string[] }
  | { type: "GROUPS_CHANGED"; groups: string[]; sequences?: SequenceSummary[] }
  | { type: "SEQUENCE_SELECTED"; sequenceId: string }
  | { type: "SEQUENCE_DESELECTED" }
  | { type: "SEQUENCE_LOAD_STARTED" }
  | { type: "SEQUENCE_LOAD_SUCCEEDED"; definition: SequenceDefinition }
  | { type: "SEQUENCE_LOAD_FAILED"; error: string }
  | {
      type: "SEQUENCE_PARAMS_RESOLVED";
      schema: ParameterSchema[];
      responseParams?: ResponseParamSchema[];
      /** Default values to seed into input fields (only for names not yet set). */
      defaults?: Record<string, unknown>;
    }
  | { type: "RESPONSE_VALUES_UPDATED"; values: Record<string, unknown> }
  | { type: "RUN_INPUTS_RESET" }
  | { type: "PARAM_CHANGED"; name: string; value: unknown }
  | { type: "PARAM_VALIDITY_UPDATED"; validity: Record<string, boolean> }
  | { type: "VISUAL_ELEMENT_CLICKED"; kind: "node" | "relationship"; id: string }
  | { type: "INSPECT_CLOSED" }
  | { type: "OPEN_BUILDER" }
  | { type: "CREATE_SEQUENCE_OPENED" }
  | { type: "EVENTS_LOAD_STARTED" }
  | { type: "EVENTS_LOAD_SUCCEEDED"; events: EventSummary[] }
  | { type: "EVENTS_LOAD_FAILED"; error: string }
  | { type: "CREATE_EVENT_OPENED" }
  | { type: "EVENT_SELECTED"; eventId: string }
  | { type: "EVENT_DESELECTED" }
  | { type: "ME_LOADED"; me: Me }
  | { type: "ME_TIMEZONE_UPDATED"; timezone: string | null }
  | { type: "PERMISSIONS_LOADED"; permissions: SpacePermissions | null }
  | { type: "SPACE_PANEL_OPENED" }
  | { type: "SPACE_PANEL_CLOSED" }
  | { type: "AUDIT_LOG_OPENED" }
  | { type: "AUDIT_LOG_LOAD_STARTED" }
  | { type: "AUDIT_LOG_LOAD_SUCCEEDED"; entries: AuditEntry[] }
  | { type: "AUDIT_LOG_LOAD_FAILED"; error: string }
  | { type: "RUN_REQUESTED" }
  | {
      type: "RUN_SUCCEEDED";
      runId: string;
      /**
       * Result to surface in the visualization panel. ``null`` means the run produced no
       * graph to show (e.g. a non-graph final response): keep the sequence design graph
       * visible and rely on the response-parameters panel for the outputs.
       */
      result:
        | { kind: "graph"; data: GraphPayload }
        | { kind: "table"; data: TablePayload }
        | null;
      /** True when the run paused mid-sequence awaiting more input (human-in-the-loop). */
      awaitingParams?: boolean;
    }
  | { type: "RUN_FAILED"; error: string }
  | { type: "RESET_RESULTS" }
  | { type: "VISUALIZATION_DISMISSED" };
