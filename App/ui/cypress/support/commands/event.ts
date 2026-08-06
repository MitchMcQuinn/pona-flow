export interface TimeEventOptions {
  name: string;
  /** 1 = Mon … 7 = Sun. Toggled as chips in group 1. */
  weekdays?: number[];
  /** "HH:MM" local time-of-day for group 1. */
  time?: string;
  /** Sequence labels to run when the event fires. */
  sequences?: string[];
}

export interface ExternalEventOptions {
  name: string;
  secret?: string;
  /** Payload filters as { path, value } using the default `equals` operator. */
  filters?: Array<{ path: string; value: string }>;
  sequences?: string[];
}

const WEEKDAY_LABELS: Record<number, string> = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun"
};

/** Open the event builder in create mode from the nav. */
Cypress.Commands.add("openEventCreator", () => {
  cy.get('[data-testid="nav-add-event"]').click();
  cy.get("#event-name", { timeout: 20_000 }).should("be.visible");
});

function selectEventSequences(labels: string[]): void {
  for (const label of labels) {
    cy.contains(".eventSeqList .eventCheckboxLabel", label).find('input[type="checkbox"]').check({
      force: true
    });
  }
}

/** Fill (but do not save) a time-schedule event in the open event builder. */
Cypress.Commands.add("fillTimeEvent", (options: TimeEventOptions) => {
  cy.get("#event-type").select("time");
  cy.get("#event-name").clear().type(options.name);

  for (const day of options.weekdays ?? []) {
    cy.get(".eventGroup")
      .first()
      .contains(".eventChip", WEEKDAY_LABELS[day])
      .click();
  }

  if (options.time) {
    cy.get(".eventGroup").first().find('input[type="time"]').clear().type(options.time);
  }

  if (options.sequences?.length) selectEventSequences(options.sequences);
});

/** Fill (but do not save) an external (webhook) event in the open event builder. */
Cypress.Commands.add("fillExternalEvent", (options: ExternalEventOptions) => {
  cy.get("#event-type").select("external");
  cy.get("#event-name").clear().type(options.name);

  if (options.secret) {
    cy.get("#event-secret").clear().type(options.secret);
  }

  (options.filters ?? []).forEach((filter, index) => {
    cy.get(".eventExternal").contains("button", "+ Add filter").click();
    cy.get(`[aria-label="Filter ${index + 1} path"]`).clear().type(filter.path);
    cy.get(`[aria-label="Filter ${index + 1} value"]`).clear().type(filter.value);
  });

  if (options.sequences?.length) selectEventSequences(options.sequences);
});

/** Save the open event and wait for it to appear in the nav events list. */
Cypress.Commands.add("saveEvent", (name: string) => {
  cy.get('[data-testid="event-save-btn"]').should("not.be.disabled").click();
  cy.get('[data-testid="nav-event-item"]').contains(".sequenceBtnLabel", name).should("be.visible");
});

/** Delete an event from the nav (handles the window.confirm prompt). */
Cypress.Commands.add("deleteEventInNav", (name: string) => {
  cy.on("window:confirm", () => true);
  cy.get(`[aria-label="Delete event ${name}"]`).click();
  cy.get('[data-testid="nav-event-item"]')
    .contains(".sequenceBtnLabel", name)
    .should("not.exist");
});
