import { GOLDEN_INSTANCE_NAME, GOLDEN_SCHEMA_LABEL } from "../../support/constants";

describe("builder: update INSTANCE", () => {
  it("matches an INSTANCE and SETs a property value", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });

    cy.updateInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.setInstanceProperty("name", "Alicia");

    cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
    cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
      "contain.text",
      "UPDATE completed successfully"
    );
  });
});
