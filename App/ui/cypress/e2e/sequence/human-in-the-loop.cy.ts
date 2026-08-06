import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_SCHEMA_LABEL,
  HITL
} from "../../support/constants";

describe("sequence: human-in-the-loop run", () => {
  it("pauses for a required parameter, then resumes to success", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });

    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.configureReadInstanceParamFilter({
      property: "name",
      paramName: HITL.PARAM_NAME
    });
    cy.saveBuilderOperation(HITL.READ_OPERATION);

    cy.openSequenceCreator();
    cy.createSequenceFromStep({
      name: HITL.SEQUENCE_NAME,
      groupTitle: HITL.SEQUENCE_GROUP,
      stepLabel: HITL.READ_OPERATION
    });

    cy.selectSequenceInNav(HITL.SEQUENCE_NAME);
    cy.triggerSequenceRun();
    cy.expectAwaitingParams();

    cy.fillSequenceParam(HITL.PARAM_NAME, GOLDEN_INSTANCE_NAME);
    cy.triggerSequenceRun();
    cy.expectRunSuccess();
  });
});
