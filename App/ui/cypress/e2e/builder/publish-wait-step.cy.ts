import { GOLDEN_SEQUENCE_GROUP } from "../../support/constants";

const STEP_LABEL = "WAIT_FIVE_SECONDS";

describe("builder: publish Wait STEP as a one-step sequence", () => {
  it("materializes a duration wait and files it as a one-step sequence", () => {
    cy.bootstrapApp();

    cy.selectBuilderOperation("create");
    cy.selectBuilderLabel("STEP");
    cy.addNewAttributiveLabelNode(STEP_LABEL);
    cy.configureWaitStep(5);

    cy.get('[data-testid="builder-run-btn"]').should("not.exist");
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

    cy.contains(
      '[data-testid="nav-sequence-item"][data-single-step="true"] .sequenceBtnLabel',
      STEP_LABEL,
      { timeout: 60_000 }
    ).should("be.visible");

    cy.selectSingleStepInNav(STEP_LABEL);
    cy.contains(
      '[data-testid="nav-sequence-item"][data-single-step="true"] .sequenceBtnLabel',
      STEP_LABEL
    )
      .closest('[data-testid="nav-sequence-item"]')
      .trigger("mouseover");
    cy.get(`[aria-label="Edit step ${STEP_LABEL}"]`).click();
    cy.get('[data-testid="builder-step-type"] button.active', { timeout: 20_000 }).should(
      "contain.text",
      "Wait"
    );
    cy.get('[data-testid="builder-wait-duration"]').should("have.value", "5");
    cy.get('[data-testid="builder-save-operation-btn"]').should("not.exist");
  });
});
