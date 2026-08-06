/**
 * Run helpers for sequence execution, including human-in-the-loop (progressive
 * parameter) runs. `cy.runSelectedSequence()` (in sequence.ts) covers the simple
 * run-to-success case; these commands cover paused/parameterized runs.
 */

/** Click the top-bar Run button without asserting the outcome (caller asserts). */
Cypress.Commands.add("triggerSequenceRun", () => {
  cy.get('[data-testid="topbar-run-btn"]', { timeout: 60_000 }).should("not.be.disabled").click();
});

/** Fill a sequence run parameter input by its parameter name. */
Cypress.Commands.add("fillSequenceParam", (name: string, value: string) => {
  cy.get(`[data-testid="param-input-${name}"] input`, { timeout: 30_000 })
    .scrollIntoView()
    .clear()
    .type(value);
});

/**
 * Assert that the run paused awaiting parameter input. The params panel shows the
 * paused hint and at least one input field once the run reaches a step that needs it.
 */
Cypress.Commands.add("expectAwaitingParams", () => {
  cy.contains(".panel__body p", "paused at a step that needs input", { timeout: 60_000 }).should(
    "be.visible"
  );
});

/** Wait for the run to finish successfully (toast). */
Cypress.Commands.add("expectRunSuccess", () => {
  cy.get('[role="status"].toast--ok', { timeout: 120_000 }).should(
    "contain.text",
    "successful execution"
  );
});
