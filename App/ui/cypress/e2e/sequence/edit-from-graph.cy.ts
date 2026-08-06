import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("sequence: edit from graph", () => {
  it("deep-links an operation-backed STEP from the design graph into the locked edit view", () => {
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
    cy.get('[data-testid="builder-operation-toggle-option-read"]').should("be.disabled");
    cy.get('[data-testid="builder-label-toggle-option-STEP"]').should("be.disabled");
  });
});
