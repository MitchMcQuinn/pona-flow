import { GOLDEN_INSTANCE_NAME, GOLDEN_SCHEMA_LABEL } from "../../support/constants";

describe("builder: read query", () => {
  it("runs a read/INSTANCE MATCH and reports completion", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });

    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);

    cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
    cy.contains(".builderRunStatus.ok", "Read completed", { timeout: 60_000 }).should("be.visible");

    // A read result populates the visualization panel.
    cy.get(".panel.vizPanel").should("be.visible");
  });
});
