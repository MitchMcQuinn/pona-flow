import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("visualization: result view", () => {
  it("toggles between result graph and result table after a run", () => {
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
    cy.runSelectedSequence();

    cy.get('[data-testid="graph-view-container"]', { timeout: 60_000 }).should("be.visible");
    cy.get('[data-testid="result-toggle-table"]').click();
    cy.get('[data-testid="result-table"]').should("be.visible");
    cy.get('[data-testid="result-toggle-graph"]').click();
    cy.get('[data-testid="graph-view-container"]').should("be.visible");
  });
});
