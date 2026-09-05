import { GOLDEN_SEQUENCE_GROUP } from "../../support/constants";

const STEP_LABEL = "PING_WEBHOOK";
const ENDPOINT = "https://example.test/ping";

describe("builder: publish HTTP STEP as a one-step sequence", () => {
  it("materializes the designed step and files it under Single-step", () => {
    cy.bootstrapApp();

    cy.selectBuilderOperation("create");
    cy.selectBuilderLabel("STEP");
    cy.addNewAttributiveLabelNode(STEP_LABEL);
    cy.configureHttpStep(ENDPOINT);

    cy.get('[data-testid="builder-create-operation-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="modal-create-operation"]').should("be.visible");
    cy.get('[data-testid="modal-create-operation"]')
      .contains("label", "name")
      .parent()
      .find("input")
      .clear()
      .type(STEP_LABEL);

    cy.get('[data-testid="modal-create-operation"]')
      .contains("label", "group title")
      .closest(".builderField")
      .find(".builderPickerToggle")
      .click();
    cy.get('[data-testid="builder-picker-menu"]')
      .contains("button.builderPickerCreate", "+ New group title")
      .click();
    cy.get('[data-testid="modal-create-operation"] input[placeholder="New group title"]')
      .clear()
      .type(GOLDEN_SEQUENCE_GROUP);
    cy.get('[data-testid="modal-create-operation"] [data-testid="modal-confirm-btn"]').click();
    cy.get('[data-testid="modal-create-operation"]').should("not.exist");
    cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
      "contain.text",
      "Step published as a one-step sequence"
    );

    cy.get('[data-testid="nav-single-step-heading"]', { timeout: 60_000 }).should("be.visible");
    cy.get('[data-testid="nav-single-step-section"]')
      .contains(".sequenceBtnLabel", STEP_LABEL)
      .should("be.visible");

    cy.selectSingleStepInNav(STEP_LABEL);
    cy.contains(
      '[data-testid="nav-sequence-item"][data-single-step="true"] .sequenceBtnLabel',
      STEP_LABEL
    )
      .closest('[data-testid="nav-sequence-item"]')
      .trigger("mouseover");
    cy.get(`[aria-label="Edit step ${STEP_LABEL}"]`).click();
    cy.contains(".builderField label", "endpoint", { timeout: 20_000 })
      .parent()
      .find("input")
      .should("have.value", ENDPOINT);
    cy.get('[data-testid="builder-save-operation-btn"]').should("not.exist");
  });
});
