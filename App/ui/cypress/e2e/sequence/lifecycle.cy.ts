import {
  E2E_SPACE_ID,
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

  it("shows a copyable webhook curl and parameter input list for a selected sequence", () => {
    seedSequence();

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.get('[data-testid="sequence-webhook-toggle"]').click();
    cy.get('[data-testid="sequence-webhook-curl"]', { timeout: 20_000 }).should(
      "contain.text",
      "/sequences/"
    );
    cy.get('[data-testid="sequence-webhook-curl"]').should("contain.text", "/run");
    cy.get('[data-testid="sequence-webhook-copy"]').should("contain.text", "Copy curl");
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

  it("highlights an orphaned sequence in red and removes it from the navigation", () => {
    seedSequence();

    cy.intercept("GET", "/api/graph/nodes-by-label*", (req) => {
      if (req.url.includes("node_label=STEP")) {
        req.reply({ statusCode: 200, body: { nodes: [] } });
      } else {
        req.continue();
      }
    }).as("emptySteps");

    cy.visit("/");
    cy.get(".appShell", { timeout: 20_000 }).should("be.visible");
    cy.get("#space-selector", { timeout: 20_000 }).should("have.value", E2E_SPACE_ID);

    cy.contains(".sequenceBtnLabel", GOLDEN_SEQUENCE_NAME, { timeout: 60_000 })
      .closest(".sequenceItem")
      .should("have.class", "orphaned");

    cy.deleteSequenceInNav(GOLDEN_SEQUENCE_NAME, "nav");
  });
});
