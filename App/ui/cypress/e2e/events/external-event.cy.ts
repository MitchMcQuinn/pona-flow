import { EVENTS } from "../../support/constants";

describe("events: external webhook trigger", () => {
  it("creates an external event with a secret and payload filter", () => {
    cy.bootstrapApp();

    cy.openEventCreator();
    cy.fillExternalEvent({
      name: EVENTS.EXTERNAL_NAME,
      secret: EVENTS.EXTERNAL_SECRET,
      filters: [{ path: "event.type", value: "created" }]
    });
    cy.saveEvent(EVENTS.EXTERNAL_NAME);

    // After the first save the backend mints an ingest token, so the inbound URL appears.
    cy.get('[data-testid="nav-event-item"]')
      .contains(".sequenceBtnLabel", EVENTS.EXTERNAL_NAME)
      .click();
    cy.get("#event-type", { timeout: 20_000 }).should("have.value", "external");
    cy.get(".agentTokenCode code").should("contain.text", "/api/hooks/");
  });
});
