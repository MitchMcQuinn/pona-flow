import { SCHEMA } from "../../support/constants";

describe("builder: delete SCHEMA", () => {
  it("previews the cascade and deletes a SCHEMA", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(SCHEMA.COMPANY_LABEL, [{ name: SCHEMA.COMPANY_PROPS.name, isLabel: true }]);

    cy.deleteSchema(SCHEMA.COMPANY_LABEL);
  });
});
