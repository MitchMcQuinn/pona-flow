import { SCHEMA } from "../../support/constants";

describe("builder: update SCHEMA", () => {
  it("adds a property to an existing SCHEMA and applies the change", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(SCHEMA.COMPANY_LABEL, [{ name: SCHEMA.COMPANY_PROPS.name, isLabel: true }]);

    // No sequences/instances depend on COMPANY yet, so the update applies without a
    // suspension. confirmSchemaUpdate tolerates both the modal and the immediate path.
    cy.addSchemaPropertyUpdate(SCHEMA.COMPANY_LABEL, SCHEMA.COMPANY_PROPS.founded);
    cy.confirmSchemaUpdate();
  });
});
