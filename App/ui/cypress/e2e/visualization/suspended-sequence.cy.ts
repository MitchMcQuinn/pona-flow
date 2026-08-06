import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("visualization: suspended sequence", () => {
  it("marks a sequence suspended after a schema drift and blocks the run button", () => {
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

    cy.addSchemaPropertyUpdate(GOLDEN_SCHEMA_LABEL, "age");
    cy.confirmSchemaUpdate();

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);

    cy.contains(".sequenceBtnLabel", GOLDEN_SEQUENCE_NAME)
      .closest(".sequenceItem")
      .should("have.class", "suspended");

    cy.get('[data-testid="topbar-run-btn"]').should("be.disabled");
    cy.expectGraphNodeAffected("STEP", GOLDEN_READ_OPERATION);
  });
});
