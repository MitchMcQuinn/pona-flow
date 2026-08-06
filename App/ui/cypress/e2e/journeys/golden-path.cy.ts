import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME,
} from "../../support/constants";

describe("golden path journey", () => {
  it("schema → instance → step → sequence → run", () => {
    cy.bootstrapApp();

    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);

    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });

    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.openSequenceCreator();
    cy.createSequenceFromStep({
      name: GOLDEN_SEQUENCE_NAME,
      groupTitle: GOLDEN_SEQUENCE_GROUP,
      stepLabel: GOLDEN_READ_OPERATION,
    });

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.runSelectedSequence();
  });
});
