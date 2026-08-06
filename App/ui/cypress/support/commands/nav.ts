export type SequenceDeleteMode = "nav" | "cascade";

function hoverSequenceInNav(sequenceLabel: string): void {
  cy.contains('[data-testid="nav-sequence-item"] .sequenceBtnLabel', sequenceLabel)
    .closest('[data-testid="nav-sequence-item"]')
    .trigger("mouseover");
}

/** Open the selected sequence in the builder for visual editing (hydrates builder_config). */
Cypress.Commands.add("editSequenceInNav", (sequenceLabel: string) => {
  hoverSequenceInNav(sequenceLabel);
  cy.get(`[aria-label="Edit sequence ${sequenceLabel}"]`).click();
  cy.get('[data-testid="builder-create-sequence-btn"]', { timeout: 20_000 }).should("be.visible");
});

/**
 * Delete a sequence from the nav. `mode` chooses between removing only the nav
 * definition ("nav") or the full cascade ("cascade"). Confirms in the modal and
 * waits for the sequence to disappear from the navigation list.
 */
Cypress.Commands.add(
  "deleteSequenceInNav",
  (sequenceLabel: string, mode: SequenceDeleteMode = "nav") => {
    hoverSequenceInNav(sequenceLabel);
    cy.get(`[aria-label="Delete sequence ${sequenceLabel}"]`).click();
    cy.get('[data-testid="modal-sequence-delete"]', { timeout: 30_000 }).should("be.visible");

    if (mode === "cascade") {
      cy.get('[data-testid="modal-sequence-delete"]')
        .find('input[name="sequence-delete-mode"][value="cascade"]')
        .check({ force: true });
    }

    cy.get('[data-testid="modal-sequence-delete"] [data-testid="modal-confirm-btn"]').click();
    cy.get('[data-testid="modal-sequence-delete"]').should("not.exist");
    cy.contains(".sequenceBtnLabel", sequenceLabel).should("not.exist");
  }
);

/** Create a new navigation group via the inline add-group control. */
Cypress.Commands.add("addNavGroup", (title: string) => {
  cy.get('[data-testid="nav-add-group"]').click();
  cy.get('.navAddGroupForm input[placeholder="Group title"]').clear().type(title);
  cy.get(".navAddGroupActions").contains("button", "Add").should("not.be.disabled").click();
  cy.contains(".navGroupTitle", title).should("be.visible");
});

/** Open the space configuration panel from the navigation gear. */
Cypress.Commands.add("openSpaceSettings", () => {
  cy.get('[data-testid="nav-space-settings"]').should("not.be.disabled").click();
  cy.get('[data-testid="space-tab-settings"]', { timeout: 20_000 }).should("be.visible");
});
