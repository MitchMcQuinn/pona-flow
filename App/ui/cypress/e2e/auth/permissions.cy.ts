describe("auth & permissions", () => {
  it("exposes all space-admin tabs to a superadmin", () => {
    cy.bootstrapApp();
    cy.openSpaceSettings();

    cy.get('[data-testid="space-tab-settings"]').should("be.visible");
    cy.get('[data-testid="space-tab-users"]').should("be.visible");
    cy.get('[data-testid="space-tab-agents"]').should("be.visible");
    cy.get('[data-testid="space-tab-credentials"]').should("be.visible");
    cy.get('[data-testid="space-tab-audit"]').should("be.visible");
  });

  it("enables all builder operations for a fully-permissioned user", () => {
    cy.bootstrapApp();

    for (const op of ["create", "read", "update", "delete"]) {
      cy.get(`[data-testid="builder-operation-toggle-option-${op}"]`).should("not.be.disabled");
    }
  });

  // The negative cases below require a second, non-privileged Clerk identity (a member
  // with a restricted role, or a principal that cannot create spaces). The single-user
  // E2E config (one CLERK_TEST_IDENTIFIER = SUPERADMIN_EMAIL) cannot exercise them.
  // Tracked in the coverage matrix; enable once a second test identity is provisioned.
  it.skip("shows the no-access screen for a user with no spaces and no create capability", () => {});
  it.skip("disables builder operations the member's role lacks", () => {});
  it.skip("hides management tabs from a non-owner member", () => {});
});
