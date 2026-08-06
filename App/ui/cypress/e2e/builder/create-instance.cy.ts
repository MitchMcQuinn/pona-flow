import { GOLDEN_INSTANCE_NAME, GOLDEN_SCHEMA_LABEL } from "../../support/constants";

describe("builder: create INSTANCE", () => {
  it("creates an INSTANCE node conforming to an existing SCHEMA", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });

    // After a successful create the builder resets; verify the operation/label
    // toggles are back to a usable state for the next mutation.
    cy.get('[data-testid="builder-operation-toggle"]').should("be.visible");
  });
});
