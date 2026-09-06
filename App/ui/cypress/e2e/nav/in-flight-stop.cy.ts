import { E2E_SPACE_ID, GOLDEN_SEQUENCE_GROUP } from "../../support/constants";

const STEP_LABEL = "WAIT_NAV_STOP";

describe("nav: in-flight activity icon and Stop Sequence", () => {
  it("shows an activity icon and Stop when in-flight lists the selected sequence", () => {
    cy.bootstrapApp();

    cy.selectBuilderOperation("create");
    cy.selectBuilderLabel("STEP");
    cy.addNewAttributiveLabelNode(STEP_LABEL);
    cy.configureWaitStep(0);

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
    )
      .closest('[data-testid="nav-sequence-item"]')
      .should("have.attr", "data-sequence-id")
      .invoke("attr", "data-sequence-id")
      .then((sequenceId) => {
        const id = String(sequenceId);
        let runs: Array<Record<string, string>> = [
          {
            sequence_id: id,
            state_id: "ID_inflight_wait",
            status: "waiting",
            reason: "duration"
          }
        ];
        cy.intercept("GET", "/api/sequence/in-flight*", (req) => {
          req.reply({ space_id: E2E_SPACE_ID, runs });
        }).as("inFlight");
        cy.intercept("POST", "/api/sequence/stop", (req) => {
          runs = [];
          req.reply({ status: "cancelled", stopped: ["ID_inflight_wait"] });
        }).as("stopSequence");

        cy.selectSingleStepInNav(STEP_LABEL);
        cy.get('[data-testid="sequence-activity-icon"]', { timeout: 10_000 }).should("be.visible");
        cy.get('[data-testid="topbar-run-btn"]').should("not.exist");
        cy.get('[data-testid="topbar-stop-btn"]').should("be.visible").click();
        cy.wait("@stopSequence");
        cy.get('[data-testid="sequence-activity-icon"]').should("not.exist");
        cy.get('[data-testid="topbar-stop-btn"]').should("not.exist");
      });
  });
});
