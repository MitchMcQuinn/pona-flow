import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("builder: edit saved operation", () => {
  it("opens a saved operation from the design graph with locked toggles and re-saves", () => {
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

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.clickGraphNode("STEP", GOLDEN_READ_OPERATION);

    cy.get('[data-testid="builder-save-operation-btn"]', { timeout: 20_000 }).should("be.visible");
    cy.get('[data-testid="builder-operation-toggle-option-create"]').should("be.disabled");
    cy.get('[data-testid="builder-label-toggle-option-STEP"]').should("be.disabled");

    cy.get('[data-testid="builder-save-operation-btn"]').should("not.be.disabled").click();
    cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
      "contain.text",
      "Operation updated"
    );
  });
});
