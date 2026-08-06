import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL
} from "../../support/constants";

describe("builder: read STEP", () => {
  it("runs a read/STEP MATCH against a saved operation", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.selectBuilderOperation("read");
    cy.selectBuilderLabel("STEP");
    cy.selectAttributiveLabelFromPicker(GOLDEN_READ_OPERATION);

    cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
    cy.contains(".builderRunStatus.ok", "Read completed", { timeout: 60_000 }).should("be.visible");
  });
});
