import "./commands/auth";
import "./commands/space";
import "./commands/builder";
import "./commands/instance";
import "./commands/operation";
import "./commands/sequence";
import "./commands/update";
import "./commands/delete";
import "./commands/nav";
import "./commands/event";
import "./commands/run";
import "./commands/graph";
import type { SchemaPropertySpec } from "./commands/builder";
import type { SequenceDeleteMode } from "./commands/nav";
import type { ExternalEventOptions, TimeEventOptions } from "./commands/event";

export {
  E2E_SPACE_DISPLAY_NAME,
  E2E_SPACE_ID,
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME,
} from "./constants";

declare global {
  namespace Cypress {
    interface Chainable {
      /** Wipe Neo4j + SQLite dev stores via `python tools/dev_reset.py --confirm`. */
      resetDevState(): Chainable<null>;
      /** Programmatic Clerk sign-in for the dedicated E2E test user (no UI). */
      signInAsTestUser(): Chainable<void>;
      /** Fill and submit the create-space modal. */
      createSpace(name: string): Chainable<void>;
      /** Create the shared E2E space and wait for the builder panel. */
      bootstrapApp(): Chainable<void>;
      /** Set the builder operation segment (create, read, update, delete). */
      selectBuilderOperation(operation: string): Chainable<void>;
      /** Set the builder label segment (STEP, SCHEMA, INSTANCE). */
      selectBuilderLabel(label: string): Chainable<void>;
      /** Pick an existing attributive_label from the open builder picker. */
      selectAttributiveLabelFromPicker(optionText: string): Chainable<void>;
      /** Open the attributive_label picker and define a new node label. */
      addNewAttributiveLabelNode(attributiveLabel: string): Chainable<void>;
      /** Append a schema property row on the current create-SCHEMA form. */
      addSchemaProperty(
        propertyName: string,
        options?: { isLabel?: boolean }
      ): Chainable<void>;
      /** Click the primary Create button and wait for the success toast. */
      runBuilderCreate(): Chainable<void>;
      /** Fill the HTTP endpoint (and a JSON object body) on the current create-STEP form. */
      configureHttpStep(endpoint: string): Chainable<void>;
      /** Full create-SCHEMA flow: operation, label, node, properties, run. */
      createSchemaNode(
        attributiveLabel: string,
        properties?: SchemaPropertySpec[]
      ): Chainable<void>;
      /** Full create-INSTANCE flow for an existing schema label. */
      createInstanceNode(
        schemaLabel: string,
        propertyValues: Record<string, string>
      ): Chainable<void>;
      /** Switch to read/INSTANCE and match by schema attributive_label. */
      configureReadInstanceMatch(schemaLabel: string): Chainable<void>;
      /** Add a WHERE filter on the current read/INSTANCE match bound to a `$param`. */
      configureReadInstanceParamFilter(options: {
        property: string;
        paramName: string;
      }): Chainable<void>;
      /** Save the current builder query as a one-step sequence (auto-wraps a STEP). */
      saveBuilderOperation(operationName: string, groupTitle?: string): Chainable<void>;
      /** Open the nav sequence creator (read/STEP builder). */
      openSequenceCreator(): Chainable<void>;
      /** Build and save a one-step sequence that matches an existing STEP label. */
      createSequenceFromStep(options: {
        name: string;
        groupTitle: string;
        stepLabel: string;
      }): Chainable<void>;
      /** Select a sequence in the left navigation panel. */
      selectSequenceInNav(sequenceLabel: string): Chainable<void>;
      /** Select a one-step sequence: params/run view, no results panel. */
      selectSingleStepInNav(sequenceLabel: string): Chainable<void>;
      /** Run the currently selected sequence from the top bar. */
      runSelectedSequence(): Chainable<void>;

      // --- update (commands/update.ts) ---
      /** Switch to update/INSTANCE and match by schema attributive_label. */
      updateInstanceMatch(schemaLabel: string): Chainable<void>;
      /** Add a bound SET assignment (schema/property/value) on the current update form. */
      setInstanceProperty(propertyName: string, value: string): Chainable<void>;
      /** Add a property to an existing SCHEMA via update/SCHEMA, then run. */
      addSchemaPropertyUpdate(schemaLabel: string, propertyName: string): Chainable<void>;
      /** Confirm the schema-update suspension modal (if shown) and await the success toast. */
      confirmSchemaUpdate(): Chainable<void>;

      // --- delete (commands/delete.ts) ---
      /** Delete a SCHEMA via the builder cascade preview + confirm modal. */
      deleteSchema(schemaLabel: string): Chainable<void>;
      /** Delete a STEP via the builder cascade preview + confirm modal. */
      deleteStep(stepLabel: string): Chainable<void>;

      // --- nav (commands/nav.ts) ---
      /** Open the selected sequence in the builder for visual editing. */
      editSequenceInNav(sequenceLabel: string): Chainable<void>;
      /** Open a one-step sequence's wrapped operation in the operation editor. */
      editSingleStepInNav(sequenceLabel: string): Chainable<void>;
      /** Delete a sequence from the nav ("nav" = remove only, "cascade" = full delete). */
      deleteSequenceInNav(
        sequenceLabel: string,
        mode?: SequenceDeleteMode
      ): Chainable<void>;
      /** Delete a one-step sequence wrap (operation + STEP; suspends multi-step dependents). */
      deleteSingleStepInNav(sequenceLabel: string): Chainable<void>;
      /** Create a navigation group via the inline add-group control. */
      addNavGroup(title: string): Chainable<void>;
      /** Open the space configuration panel from the navigation gear. */
      openSpaceSettings(): Chainable<void>;

      // --- events (commands/event.ts) ---
      /** Open the event builder in create mode. */
      openEventCreator(): Chainable<void>;
      /** Fill (not save) a time-schedule event in the open event builder. */
      fillTimeEvent(options: TimeEventOptions): Chainable<void>;
      /** Fill (not save) an external webhook event in the open event builder. */
      fillExternalEvent(options: ExternalEventOptions): Chainable<void>;
      /** Save the open event and wait for it to appear in the nav. */
      saveEvent(name: string): Chainable<void>;
      /** Delete an event from the nav (handles window.confirm). */
      deleteEventInNav(name: string): Chainable<void>;

      // --- space admin (commands/space.ts) ---
      /** Switch to a space-config tab (settings | users | agents | credentials | audit). */
      openSpaceTab(
        tab: "settings" | "users" | "agents" | "credentials" | "audit"
      ): Chainable<void>;
      /** Invite a member by email on the open Users tab. */
      inviteMember(email: string): Chainable<void>;
      /** Create an agent API key on the open Agents tab (resolves the one-time token modal). */
      createAgentKey(name: string): Chainable<void>;
      /** Upsert a credential on the open Credentials tab. */
      upsertCredential(name: string, value: string): Chainable<void>;

      // --- run (commands/run.ts) ---
      /** Click the top-bar Run button without asserting the outcome. */
      triggerSequenceRun(): Chainable<void>;
      /** Fill a sequence run parameter input by name (`#param-<name>`). */
      fillSequenceParam(name: string, value: string): Chainable<void>;
      /** Assert the run paused awaiting parameter input. */
      expectAwaitingParams(): Chainable<void>;
      /** Wait for a successful sequence run (toast). */
      expectRunSuccess(): Chainable<void>;

      // --- graph (commands/graph.ts) ---
      /** Click a D3 graph node by label group (STEP, INSTANCE, …) and display label. */
      clickGraphNode(group: string, label: string): Chainable<void>;
      /** Click a D3 graph relationship by its display label. */
      clickGraphRelationship(label: string): Chainable<void>;
      /** Assert a graph node is highlighted red (schema drift / out-of-sync). */
      expectGraphNodeAffected(group: string, label: string): Chainable<void>;
    }
  }
}
