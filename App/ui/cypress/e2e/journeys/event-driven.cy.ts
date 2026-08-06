import {
  EVENTS,
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("journey: event-driven sequence", () => {
  it("builds a sequence, schedules a time event for it, then runs it manually", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.openSequenceCreator();
    cy.createSequenceFromStep({
      name: GOLDEN_SEQUENCE_NAME,
      groupTitle: GOLDEN_SEQUENCE_GROUP,
      stepLabel: GOLDEN_READ_OPERATION
    });

    // Schedule a time event that runs the sequence on weekday mornings.
    cy.openEventCreator();
    cy.fillTimeEvent({
      name: EVENTS.TIME_NAME,
      weekdays: [1, 2, 3, 4, 5],
      time: "08:00",
      sequences: [GOLDEN_SEQUENCE_NAME]
    });
    cy.saveEvent(EVENTS.TIME_NAME);

    // The sequence still runs on demand from the top bar.
    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.runSelectedSequence();
  });
});
