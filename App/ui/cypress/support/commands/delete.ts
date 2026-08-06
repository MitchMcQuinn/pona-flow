import { openAttributiveLabelPicker, pickFromOpenPicker } from "./helpers";

/**
 * Delete a SCHEMA through the builder cascade flow: select delete/SCHEMA, match the
 * target, trigger the preview, then confirm in the cascade modal. Waits for the
 * success toast confirming the schema was deleted or removed from the space.
 */
Cypress.Commands.add("deleteSchema", (schemaLabel: string) => {
  cy.selectBuilderOperation("delete");
  cy.selectBuilderLabel("SCHEMA");
  openAttributiveLabelPicker();
  pickFromOpenPicker(schemaLabel);

  cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();

  cy.get('[data-testid="modal-schema-delete"]', { timeout: 30_000 }).should("be.visible");
  cy.get('[data-testid="modal-schema-delete"] [data-testid="modal-confirm-btn"]').click();
  cy.get('[data-testid="modal-schema-delete"]').should("not.exist");

  cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
    "contain.text",
    `Schema "${schemaLabel}"`
  );
});

/**
 * Delete a STEP through the builder cascade flow: select delete/STEP, match the
 * target, trigger the preview, then confirm in the cascade modal.
 */
Cypress.Commands.add("deleteStep", (stepLabel: string) => {
  cy.selectBuilderOperation("delete");
  cy.selectBuilderLabel("STEP");
  openAttributiveLabelPicker();
  pickFromOpenPicker(stepLabel);

  cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();

  cy.get('[data-testid="modal-step-delete"]', { timeout: 30_000 }).should("be.visible");
  cy.get('[data-testid="modal-step-delete"] [data-testid="modal-confirm-btn"]').click();
  cy.get('[data-testid="modal-step-delete"]').should("not.exist");

  cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
    "contain.text",
    `Step "${stepLabel}"`
  );
});
