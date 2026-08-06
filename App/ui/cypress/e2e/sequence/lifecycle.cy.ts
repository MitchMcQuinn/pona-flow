import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

/** Build the golden schema → instance → operation → sequence chain used by these specs. */
function seedSequence(): void {
  cy.bootstrapApp();
  cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
  cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
  cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
  cy.saveBuilderOperation(GOLDEN_READ_OPERATION);
  cy.openSequenceCreator();
  cy.createSequenceFromStep({
    name: GOLDEN_SEQUENCE_NAME,
    groupTitle: GOLDEN_SEQUENCE_GROUP,
    stepLabel: GOLDEN_READ_OPERATION
  });
}

describe("sequence: lifecycle", () => {
  it("edits sequence description metadata in the params panel", () => {
    seedSequence();

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.contains(".sequenceDescriptionHead button", "Add").click();
    cy.get(".sequenceDescriptionInput")
      .clear()
      .type("E2E lifecycle description for agents.");
    cy.contains(".sequenceDescription .buttonRow button", "Save").click();
    cy.get(".sequenceDescription").should("contain.text", "E2E lifecycle description for agents.");
  });

  it("edits a sequence from the nav and re-saves its builder config", () => {
    seedSequence();

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.editSequenceInNav(GOLDEN_SEQUENCE_NAME);

    // Edit mode locks the name and offers a single "Save sequence" action.
    cy.get('[data-testid="builder-create-sequence-btn"]')
      .should("contain.text", "Save sequence")
      .click();

    cy.contains(".sequenceBtnLabel", GOLDEN_SEQUENCE_NAME, { timeout: 60_000 }).should(
      "be.visible"
    );
  });

  it("removes a sequence from the navigation only (least destructive delete)", () => {
    seedSequence();

    cy.deleteSequenceInNav(GOLDEN_SEQUENCE_NAME, "nav");
  });
});
