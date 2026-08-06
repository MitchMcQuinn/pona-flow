describe("space: delete", () => {
  it("deletes the space via the confirm modal", () => {
    cy.bootstrapApp();
    cy.openSpaceSettings();
    cy.openSpaceTab("settings");

    cy.get('[data-testid="space-delete-btn"]').click();
    cy.get('[data-testid="modal-delete-space"]').should("be.visible");
    cy.get('[data-testid="modal-delete-space"] [data-testid="modal-confirm-btn"]').click();
    cy.get('[data-testid="modal-delete-space"]').should("not.exist");

    // It was the only space and the test user can create spaces, so the required
    // create-space modal reappears (the no-space bootstrap path).
    cy.get('[data-testid="modal-create-space"]', { timeout: 20_000 }).should("be.visible");
  });
});
