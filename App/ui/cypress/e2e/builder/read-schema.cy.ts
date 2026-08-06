import { SCHEMA } from "../../support/constants";

describe("builder: read SCHEMA", () => {
  it("runs a read/SCHEMA MATCH and reports completion", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(SCHEMA.COMPANY_LABEL, [{ name: SCHEMA.COMPANY_PROPS.name, isLabel: true }]);

    cy.selectBuilderOperation("read");
    cy.selectBuilderLabel("SCHEMA");
    cy.selectAttributiveLabelFromPicker(SCHEMA.COMPANY_LABEL);

    cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
    cy.contains(".builderRunStatus.ok", "Read completed", { timeout: 60_000 }).should("be.visible");
  });
});
