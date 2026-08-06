import { EVENTS } from "../../support/constants";

describe("events: time trigger", () => {
  it("creates, lists, and deletes a time-schedule event", () => {
    cy.bootstrapApp();

    cy.openEventCreator();
    cy.fillTimeEvent({
      name: EVENTS.TIME_NAME,
      weekdays: [1, 2, 3, 4, 5],
      time: "09:00"
    });
    cy.saveEvent(EVENTS.TIME_NAME);

    cy.deleteEventInNav(EVENTS.TIME_NAME);
  });

  it("edits an existing event's name", () => {
    cy.bootstrapApp();

    cy.openEventCreator();
    cy.fillTimeEvent({ name: EVENTS.TIME_NAME, weekdays: [1] });
    cy.saveEvent(EVENTS.TIME_NAME);

    cy.get('[data-testid="nav-event-item"]').contains(".sequenceBtnLabel", EVENTS.TIME_NAME).click();
    cy.get("#event-name", { timeout: 20_000 }).should("have.value", EVENTS.TIME_NAME);

    const renamed = `${EVENTS.TIME_NAME} (edited)`;
    cy.get("#event-name").clear().type(renamed);
    cy.saveEvent(renamed);
  });
});
