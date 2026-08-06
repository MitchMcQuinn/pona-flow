import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL
} from "../../support/constants";

describe("builder: delete STEP", () => {
  it("deletes a saved operation's STEP via the cascade preview", () => {
    cy.bootstrapApp();

    // A saved operation wraps a STEP node, which is then deletable via delete/STEP.
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.deleteStep(GOLDEN_READ_OPERATION);
  });
});
