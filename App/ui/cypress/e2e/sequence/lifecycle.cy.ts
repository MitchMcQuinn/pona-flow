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

    cy.get('[data-testid="builder-sequence-name"]')
      .should("be.enabled")
      .clear()
      .type(`${GOLDEN_SEQUENCE_NAME}_RENAMED`);

    cy.get('[data-testid="builder-create-sequence-btn"]')
      .should("contain.text", "Save sequence")
      .click();

    cy.contains(".sequenceBtnLabel", `${GOLDEN_SEQUENCE_NAME}_RENAMED`, { timeout: 60_000 }).should(
      "be.visible"
    );
  });

  it("keeps a sequence title when the new name is already a STEP label", () => {
    seedSequence();

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.editSequenceInNav(GOLDEN_SEQUENCE_NAME);

    // PERSON is a SCHEMA attributive_label, so the graph identity cannot follow;
    // the workspace title still saves. (READ_PERSON is now also a one-step sequence
    // title, so it is not a valid uniqueness-free target.)
    cy.get('[data-testid="builder-sequence-name"]').should("be.enabled").clear().type(GOLDEN_SCHEMA_LABEL);

    cy.get('[data-testid="builder-create-sequence-btn"]')
      .should("contain.text", "Save sequence")
      .click();

    cy.contains(".sequenceBtnLabel", GOLDEN_SCHEMA_LABEL, { timeout: 60_000 }).should(
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
      .closest('[data-testid="nav-sequence-item"]')
      .should("have.class", "orphaned")
      .and("have.attr", "data-orphaned", "true")
      .trigger("mouseenter");
    cy.get('[data-testid="nav-sequence-tooltip"]', { timeout: 5_000 })
      .should("be.visible")
      .and("contain.text", "Orphaned");

    cy.deleteSequenceInNav(GOLDEN_SEQUENCE_NAME, "nav");
  });

  it("files a new operation under Single step sequences and opens the params view", () => {
    cy.bootstrapApp();
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.get('[data-testid="nav-single-step-heading"]', { timeout: 60_000 }).should("be.visible");
    cy.contains(
      '[data-testid="nav-sequence-item"][data-single-step="true"] .sequenceBtnLabel',
      GOLDEN_READ_OPERATION
    )
      .closest('[data-testid="nav-sequence-item"]')
      .should("not.have.class", "orphaned")
      .and("not.have.class", "suspended");
    cy.selectSingleStepInNav(GOLDEN_READ_OPERATION);

    cy.editSingleStepInNav(GOLDEN_READ_OPERATION);
    cy.get('[data-testid="builder-operation-name"]')
      .should("have.value", GOLDEN_READ_OPERATION)
      .parents(".builderField")
      .first()
      .should("not.contain.text", "Already used");
    cy.get('[data-testid="builder-save-operation-btn"]').should("not.be.disabled");

    cy.get('[data-testid="builder-operation-name"]').clear().type("READ_PERSON_RENAMED");
    cy.get('[data-testid="builder-save-operation-btn"]').should("not.be.disabled").click();
    cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should("contain.text", "Operation updated");
    cy.get('[data-testid="nav-single-step-section"]')
      .contains(".sequenceBtnLabel", "READ_PERSON_RENAMED", { timeout: 60_000 })
      .should("be.visible");
  });

  it("deletes a single-step sequence without dependents", () => {
    cy.bootstrapApp();
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.get('[data-testid="nav-single-step-section"]', { timeout: 60_000 })
      .contains(".sequenceBtnLabel", GOLDEN_READ_OPERATION)
      .should("be.visible");
    cy.deleteSingleStepInNav(GOLDEN_READ_OPERATION);
    cy.get('[data-testid="nav-single-step-heading"]').should("not.exist");
  });

  it("shows the results panel after running a single-step sequence", () => {
    cy.bootstrapApp();
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);

    cy.selectSingleStepInNav(GOLDEN_READ_OPERATION);
    cy.runSelectedSequence();
    cy.get("main.layoutResizable").should("not.have.class", "layoutVizHidden");
    cy.contains("h2", "Result", { timeout: 20_000 }).should("be.visible");
  });
});
