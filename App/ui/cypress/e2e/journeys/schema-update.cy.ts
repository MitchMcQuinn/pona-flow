import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL
} from "../../support/constants";

describe("journey: schema update after operation exists", () => {
  it("adds a schema property while a dependent operation exists and applies the change", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    // Adding a property may surface the suspension-impact modal (a dependent operation
    // now exists). confirmSchemaUpdate handles both the modal and the immediate-apply path.
    cy.addSchemaPropertyUpdate(GOLDEN_SCHEMA_LABEL, "age");
    cy.confirmSchemaUpdate();
  });
});
