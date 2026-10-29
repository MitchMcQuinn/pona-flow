import type { AppEvent } from "./events";
import type { AppState } from "./types";

// Fresh-object reset fragments shared by the navigation-style events (selecting a
// space/sequence/event, opening the builder or a panel), which each reset several
// state domains at once. Factories (not constants) so every reset produces a new
// object, exactly as the previous inline literals did.
const emptySequence = (): AppState["sequence"] => ({
  definition: null,
  loading: false,
  error: null
});

const resetEditor = (): AppState["editor"] => ({
  selectedElement: null,
  dirty: false
});

const resetParams = (): AppState["params"] => ({
  schema: [],
  values: {},
  validity: {},
  allValid: false,
  touched: false,
  responseParams: [],
  responseValues: {}
});

const idleRun = (): AppState["run"] => ({
  status: "idle",
  lastRunId: null,
  error: null,
  awaitingParams: false
});

const emptyResults = (): AppState["results"] => ({
  kind: null,
  graphData: null,
  tableData: null
});

const emptyEvents = (): AppState["events"] => ({
  items: [],
  groups: [],
  selectedEventId: null,
  loading: false,
  error: null,
  editNonce: 0
});

const emptyConsoles = (): AppState["consoles"] => ({
  items: [],
  groups: [],
  selectedConsoleId: null,
  loading: false,
  error: null,
  editNonce: 0
});

function deselectConsole(state: AppState): AppState["consoles"] {
  if (!state.consoles.selectedConsoleId && state.consoles.editNonce === 0) return state.consoles;
  return { ...state.consoles, selectedConsoleId: null, editNonce: 0 };
}

function deselectEvent(state: AppState): AppState["events"] {
  if (!state.events.selectedEventId && state.events.editNonce === 0) return state.events;
  return { ...state.events, selectedEventId: null, editNonce: 0 };
}

/** A fresh visit opens closed. Re-selecting the item already on screen keeps its edit session.
    The nav edit icon bumps the nonce so that visit opens in edit mode. */
function editNonceForSelection(
  currentId: string | null,
  nextId: string,
  nonce: number,
  edit: boolean | undefined
): number {
  if (edit) return nonce + 1;
  if (currentId === nextId) return nonce;
  return 0;
}

const emptyAuditLog = (): AppState["auditLog"] => ({
  entries: [],
  loading: false,
  error: null
});

export const initialState: AppState = {
  spaceId: null,
  me: null,
  permissions: null,
  spacePanelOpen: false,
  nav: {
    sequences: [],
    groups: [],
    selectedSequenceId: null,
    loading: false,
    error: null
  },
  sequence: emptySequence(),
  editor: resetEditor(),
  params: resetParams(),
  run: idleRun(),
  inFlight: [],
  view: {
    rightPanelMode: "builder",
    visualMode: "empty"
  },
  createSequence: false,
  events: emptyEvents(),
  createEvent: false,
  consoles: emptyConsoles(),
  auditLog: emptyAuditLog(),
  results: emptyResults()
};

function computeAllValid(validity: Record<string, boolean>, schemaLength: number): boolean {
  if (schemaLength === 0) return true;
  return Object.keys(validity).length >= schemaLength && Object.values(validity).every(Boolean);
}

function nextRightPanelMode(state: AppState): AppState["view"]["rightPanelMode"] {
  if (state.editor.selectedElement) return "inspect";
  if (state.spacePanelOpen) return "space";
  if (state.createEvent || state.events.selectedEventId) return "event";
  if (state.nav.selectedSequenceId) return "params";
  return "builder";
}

export function appReducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "SPACE_SELECTED":
      return {
        ...state,
        spaceId: event.spaceId,
        permissions: null,
        spacePanelOpen: false,
        nav: {
          ...state.nav,
          selectedSequenceId: null,
          sequences: [],
          groups: [],
          error: null
        },
        sequence: emptySequence(),
        editor: resetEditor(),
        params: resetParams(),
        run: idleRun(),
        inFlight: [],
        view: {
          rightPanelMode: "builder",
          visualMode: "empty"
        },
        createSequence: false,
        events: emptyEvents(),
        createEvent: false,
        consoles: emptyConsoles(),
        auditLog: emptyAuditLog(),
        results: emptyResults()
      };

    case "SEQUENCES_LOAD_STARTED":
      return {
        ...state,
        nav: {
          ...state.nav,
          loading: true,
          error: null
        }
      };

    case "SEQUENCES_LOAD_SUCCEEDED":
      return {
        ...state,
        nav: {
          ...state.nav,
          loading: false,
          sequences: event.sequences
        }
      };

    case "SEQUENCES_LOAD_FAILED":
      return {
        ...state,
        nav: {
          ...state.nav,
          loading: false,
          error: event.error
        }
      };

    case "SEQUENCES_REORDERED":
      return {
        ...state,
        nav: {
          ...state.nav,
          sequences: event.sequences
        }
      };

    case "GROUPS_LOADED":
      return {
        ...state,
        nav: {
          ...state.nav,
          groups: event.groups
        },
        events: {
          ...state.events,
          groups: event.eventGroups
        },
        consoles: {
          ...state.consoles,
          groups: event.consoleGroups
        }
      };

    case "GROUPS_CHANGED":
      return {
        ...state,
        nav: {
          ...state.nav,
          groups: event.groups,
          sequences: event.sequences ?? state.nav.sequences
        }
      };

    case "SEQUENCE_DESELECTED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: resetEditor(),
        params: resetParams(),
        run: idleRun(),
        view: {
          rightPanelMode: "builder",
          visualMode: "empty"
        },
        results: emptyResults()
      };

    case "SEQUENCE_SELECTED": {
      // Re-selecting the already-selected sequence must be a no-op: the loader effect is
      // keyed on selectedSequenceId, so it won't re-run for an unchanged id. Resetting
      // sequence.loading to true here (without the effect to clear it) would otherwise leave
      // the visualization panel stuck on "Loading step flow...".
      if (state.nav.selectedSequenceId === event.sequenceId) {
        return state;
      }
      const singleStep = Boolean(
        state.nav.sequences.find((sequence) => sequence.id === event.sequenceId)?.singleStep
      );
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: event.sequenceId
        },
        sequence: {
          definition: null,
          loading: !singleStep,
          error: null
        },
        editor: {
          ...state.editor,
          selectedElement: null
        },
        params: resetParams(),
        run: idleRun(),
        view: {
          ...state.view,
          visualMode: singleStep ? "empty" : "design_graph",
          rightPanelMode: "params"
        },
        results: emptyResults(),
        createSequence: false,
        spacePanelOpen: false,
        events: deselectEvent(state),
        createEvent: false,
        consoles: deselectConsole(state)
      };
    }

    case "SEQUENCE_LOAD_STARTED":
      return {
        ...state,
        sequence: {
          ...state.sequence,
          loading: true,
          error: null
        }
      };

    case "SEQUENCE_PARAMS_RESOLVED": {
      // Pre-fill author-supplied defaults for any newly-revealed input that the
      // operator hasn't already entered a value for. The user can still edit them.
      const seededValues = { ...state.params.values };
      if (event.defaults) {
        for (const [name, value] of Object.entries(event.defaults)) {
          if (seededValues[name] === undefined || seededValues[name] === "") {
            seededValues[name] = value;
          }
        }
      }
      return {
        ...state,
        params: {
          ...state.params,
          schema: event.schema,
          values: seededValues,
          responseParams: event.responseParams ?? state.params.responseParams,
          allValid: event.schema.length === 0
        }
      };
    }

    case "RESPONSE_VALUES_UPDATED":
      return {
        ...state,
        params: {
          ...state.params,
          responseValues: { ...state.params.responseValues, ...event.values }
        }
      };

    case "RUN_INPUTS_RESET":
      // Fresh run: clear the progressively-revealed input schema, its values, and any resolved
      // response values so the next run reveals each step's inputs again as it reaches them.
      // responseParams (the output definitions from compose) are intentionally preserved.
      return {
        ...state,
        params: {
          ...state.params,
          schema: [],
          values: {},
          validity: {},
          allValid: true,
          touched: false,
          responseValues: {}
        }
      };

    case "SEQUENCE_LOAD_SUCCEEDED":
      // Only update the sequence definition here. The params schema is owned exclusively by
      // SEQUENCE_PARAMS_RESOLVED (from the composed package), which correctly drops inputs that
      // are satisfied by response parameters. Setting the cruder definition.parameterSchema here
      // would make the properties panel flash open (non-empty) and then closed (composed empty),
      // and could clobber the composed schema when this resolves last.
      return {
        ...state,
        sequence: {
          definition: event.definition,
          loading: false,
          error: null
        }
      };

    case "SEQUENCE_LOAD_FAILED":
      return {
        ...state,
        sequence: {
          ...state.sequence,
          loading: false,
          error: event.error
        }
      };

    case "PARAM_CHANGED":
      return {
        ...state,
        params: {
          ...state.params,
          values: {
            ...state.params.values,
            [event.name]: event.value
          },
          touched: true
        },
        run: {
          ...state.run,
          status: "validating"
        }
      };

    case "PARAM_VALIDITY_UPDATED": {
      const allValid = computeAllValid(event.validity, state.params.schema.length);
      return {
        ...state,
        params: {
          ...state.params,
          validity: event.validity,
          allValid
        },
        run: {
          ...state.run,
          status: allValid ? "ready" : "idle"
        }
      };
    }

    case "VISUAL_ELEMENT_CLICKED":
      return {
        ...state,
        editor: {
          ...state.editor,
          selectedElement: {
            kind: event.kind,
            id: event.id
          }
        },
        view: {
          ...state.view,
          rightPanelMode: "inspect"
        },
        spacePanelOpen: false
      };

    case "INSPECT_CLOSED": {
      const nextState = {
        ...state,
        editor: {
          ...state.editor,
          selectedElement: null
        }
      };
      return {
        ...nextState,
        view: {
          ...nextState.view,
          rightPanelMode: nextRightPanelMode(nextState)
        }
      };
    }

    case "OPEN_BUILDER":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: resetEditor(),
        params: resetParams(),
        run: idleRun(),
        view: {
          rightPanelMode: "builder",
          visualMode: "empty"
        },
        results: emptyResults(),
        createSequence: false,
        spacePanelOpen: false,
        events: deselectEvent(state),
        createEvent: false,
        consoles: deselectConsole(state)
      };

    case "CREATE_SEQUENCE_OPENED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: {
          ...state.editor,
          selectedElement: null
        },
        params: resetParams(),
        view: {
          ...state.view,
          rightPanelMode: "builder",
          visualMode: "empty"
        },
        results: emptyResults(),
        createSequence: true,
        spacePanelOpen: false,
        events: deselectEvent(state),
        createEvent: false,
        consoles: deselectConsole(state)
      };

    case "EVENTS_LOAD_STARTED":
      return {
        ...state,
        events: {
          ...state.events,
          loading: true,
          error: null
        }
      };

    case "EVENTS_LOAD_SUCCEEDED":
      return {
        ...state,
        events: {
          ...state.events,
          loading: false,
          items: event.events
        }
      };

    case "EVENTS_REORDERED":
      return {
        ...state,
        events: {
          ...state.events,
          items: event.events
        }
      };

    case "EVENT_GROUPS_CHANGED":
      return {
        ...state,
        events: {
          ...state.events,
          groups: event.groups,
          items: event.events ?? state.events.items
        }
      };

    case "EVENTS_LOAD_FAILED":
      return {
        ...state,
        events: {
          ...state.events,
          loading: false,
          error: event.error
        }
      };

    case "CREATE_EVENT_OPENED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: {
          ...state.editor,
          selectedElement: null
        },
        view: {
          ...state.view,
          rightPanelMode: "event",
          visualMode: "empty"
        },
        createSequence: false,
        spacePanelOpen: false,
        events: deselectEvent(state),
        createEvent: true,
        consoles: deselectConsole(state),
        results: emptyResults()
      };

    case "EVENT_SELECTED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: {
          ...state.editor,
          selectedElement: null
        },
        view: {
          ...state.view,
          rightPanelMode: "event",
          visualMode: "empty"
        },
        createSequence: false,
        spacePanelOpen: false,
        events: {
          ...state.events,
          selectedEventId: event.eventId,
          editNonce: editNonceForSelection(
            state.events.selectedEventId,
            event.eventId,
            state.events.editNonce,
            event.edit
          )
        },
        createEvent: false,
        consoles: deselectConsole(state),
        results: emptyResults()
      };

    case "EVENT_DESELECTED":
      return {
        ...state,
        view: {
          ...state.view,
          rightPanelMode: "builder",
          visualMode: "empty"
        },
        createEvent: false,
        events: deselectEvent(state)
      };

    case "CONSOLES_LOAD_STARTED":
      return {
        ...state,
        consoles: { ...state.consoles, loading: true, error: null }
      };

    case "CONSOLES_LOAD_SUCCEEDED":
      return {
        ...state,
        consoles: {
          ...state.consoles,
          loading: false,
          items: event.consoles
        }
      };

    case "CONSOLES_REORDERED":
      return {
        ...state,
        consoles: {
          ...state.consoles,
          items: event.consoles
        }
      };

    case "CONSOLE_GROUPS_CHANGED":
      return {
        ...state,
        consoles: {
          ...state.consoles,
          groups: event.groups,
          items: event.consoles ?? state.consoles.items
        }
      };

    case "CONSOLES_LOAD_FAILED":
      return {
        ...state,
        consoles: { ...state.consoles, loading: false, error: event.error }
      };

    case "CONSOLE_SELECTED":
      return {
        ...state,
        nav: { ...state.nav, selectedSequenceId: null },
        sequence: emptySequence(),
        editor: { ...state.editor, selectedElement: null },
        view: { ...state.view, rightPanelMode: "builder", visualMode: "empty" },
        createSequence: false,
        spacePanelOpen: false,
        createEvent: false,
        events: deselectEvent(state),
        consoles: {
          ...state.consoles,
          selectedConsoleId: event.consoleId,
          editNonce: editNonceForSelection(
            state.consoles.selectedConsoleId,
            event.consoleId,
            state.consoles.editNonce,
            event.edit
          )
        },
        results: emptyResults()
      };

    case "CONSOLE_RENAMED": {
      const current = state.consoles.items.find((item) => item.id === event.consoleId);
      if (!current || current.name === event.name) return state;
      return {
        ...state,
        consoles: {
          ...state.consoles,
          items: state.consoles.items.map((item) =>
            item.id === event.consoleId ? { ...item, name: event.name } : item
          )
        }
      };
    }

    case "CONSOLE_DESELECTED":
      return {
        ...state,
        consoles: deselectConsole(state)
      };

    case "ME_LOADED":
      return { ...state, me: event.me };

    case "ME_TIMEZONE_UPDATED":
      return state.me
        ? { ...state, me: { ...state.me, timezone: event.timezone } }
        : state;

    case "ME_WORKBENCH_UPDATED":
      return state.me
        ? { ...state, me: { ...state.me, workbenchMode: event.mode } }
        : state;

    case "ME_ONBOARDING_TOUR_SEEN":
      return state.me
        ? { ...state, me: { ...state.me, onboardingTourSeen: event.seen } }
        : state;

    case "PERMISSIONS_LOADED":
      return { ...state, permissions: event.permissions };

    case "SPACE_PANEL_OPENED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: {
          ...state.editor,
          selectedElement: null
        },
        createSequence: false,
        createEvent: false,
        events: deselectEvent(state),
        consoles: deselectConsole(state),
        spacePanelOpen: true,
        view: {
          ...state.view,
          rightPanelMode: "space",
          visualMode: "empty"
        },
        results: emptyResults()
      };

    case "SPACE_PANEL_CLOSED": {
      const usersClosed = { ...state, spacePanelOpen: false };
      return {
        ...usersClosed,
        view: {
          ...state.view,
          rightPanelMode: nextRightPanelMode(usersClosed)
        }
      };
    }

    case "AUDIT_LOG_OPENED":
      return {
        ...state,
        nav: {
          ...state.nav,
          selectedSequenceId: null
        },
        sequence: emptySequence(),
        editor: {
          ...state.editor,
          selectedElement: null
        },
        createSequence: false,
        createEvent: false,
        spacePanelOpen: false,
        events: deselectEvent(state),
        consoles: deselectConsole(state),
        view: {
          rightPanelMode: "builder",
          visualMode: "audit_log"
        },
        results: emptyResults()
      };

    case "AUDIT_LOG_LOAD_STARTED":
      return {
        ...state,
        auditLog: {
          ...state.auditLog,
          loading: true,
          error: null
        }
      };

    case "AUDIT_LOG_LOAD_SUCCEEDED":
      return {
        ...state,
        auditLog: {
          entries: event.entries,
          loading: false,
          error: null
        }
      };

    case "AUDIT_LOG_LOAD_FAILED":
      return {
        ...state,
        auditLog: {
          ...state.auditLog,
          loading: false,
          error: event.error
        }
      };

    case "RUN_REQUESTED":
      return {
        ...state,
        run: {
          ...state.run,
          status: "running",
          error: null
        }
      };

    case "RUN_SUCCEEDED": {
      const run = {
        status: "success" as const,
        lastRunId: event.runId,
        error: null,
        awaitingParams: Boolean(event.awaitingParams)
      };
      // No graph result: clear stale results and keep the sequence design graph in view.
      if (!event.result) {
        return {
          ...state,
          run,
          results: emptyResults(),
          view: { ...state.view, visualMode: "design_graph" }
        };
      }
      return {
        ...state,
        run,
        results: {
          kind: event.result.kind,
          graphData: event.result.kind === "graph" ? event.result.data : null,
          tableData: event.result.kind === "table" ? event.result.data : null
        },
        view: {
          ...state.view,
          visualMode: event.result.kind === "graph" ? "result_graph" : "result_table"
        }
      };
    }

    case "RUN_FAILED":
      return {
        ...state,
        run: {
          ...state.run,
          status: "error",
          error: event.error,
          awaitingParams: false
        }
      };

    case "IN_FLIGHT_UPDATED":
      return { ...state, inFlight: event.runs };

    case "RESET_RESULTS":
      return {
        ...state,
        results: emptyResults(),
        view: {
          ...state.view,
          visualMode: state.nav.selectedSequenceId ? "design_graph" : "empty"
        }
      };

    case "VISUALIZATION_DISMISSED":
      return {
        ...state,
        results: emptyResults(),
        view: {
          ...state.view,
          visualMode: "empty"
        }
      };

    default:
      return state;
  }
}
