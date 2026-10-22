import { EVENTS } from "../../support/constants";

describe("events: simulated event", () => {
  it("creates a simulated event and shows the session endpoint references", () => {
    cy.bootstrapApp();

    cy.openEventCreator();
    cy.get('[data-testid="event-type-toggle-option-simulated"]').click();
    cy.get("#event-name").clear().type(EVENTS.SIMULATED_NAME);
    cy.get("#sim-tic-duration").clear().type("15");
    cy.get("#sim-probability-name").clear().type("Weather");
    cy.get("#sim-outcome-weight").clear().type("5");
    cy.get("#sim-sequence").click();
    cy.get('[data-testid="sim-sequence-menu"] button.builderPickerItem').then(($items) => {
      const next = [...$items].find((el) => (el.textContent || "").trim() !== "Record only");
      if (next) {
        cy.wrap(next).click();
      } else {
        cy.get("#sim-sequence").click();
      }
    });
    cy.saveEvent(EVENTS.SIMULATED_NAME);

    cy.get('[data-testid="nav-event-item"]')
      .contains(".sequenceBtnLabel", EVENTS.SIMULATED_NAME)
      .click();
    cy.get('[data-testid="event-type-toggle-option-simulated"]', { timeout: 20_000 }).should(
      "have.attr",
      "aria-checked",
      "true"
    );
    cy.get('[data-testid="sim-url-create"]')
      .should("contain.text", "/api/sim/")
      .and("contain.text", "/sessions");
    cy.get('[data-testid="sim-url-delete"]').should("contain.text", "DELETE");
    cy.get('[data-testid="sim-url-tic"]').should("contain.text", "/tic");
    cy.get('[data-testid="sim-url-clear"]').should("contain.text", "clear-error");
    cy.get(".eventSeqList").should("not.exist");
  });
});
