import { SPACE_ADMIN } from "../../support/constants";

// The E2E test user matches SUPERADMIN_EMAIL after dev_reset, so all management tabs
// are available.
describe("space administration", () => {
  beforeEach(() => {
    cy.bootstrapApp();
    cy.openSpaceSettings();
  });

  it("edits and saves space settings", () => {
    cy.openSpaceTab("settings");
    cy.contains(".builderField label", "description (optional)")
      .parent()
      .find("textarea")
      .clear()
      .type("Updated by E2E settings spec.");
    cy.get('[data-testid="space-settings-save-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="space-settings-save-btn"]', { timeout: 20_000 }).should(
      "contain.text",
      "Save changes"
    );
  });

  it("toggles dev mode and shows the builder query preview", () => {
    cy.openSpaceTab("settings");
    cy.get("#space-dev-mode-toggle", { timeout: 20_000 })
      .should("not.be.disabled")
      .and("have.attr", "aria-checked", "false")
      .click();
    cy.get("#space-dev-mode-toggle").should("have.attr", "aria-checked", "true");
    cy.get('[data-testid="space-settings-save-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="space-settings-save-btn"]', { timeout: 20_000 }).should(
      "contain.text",
      "Save changes"
    );
    cy.get("#space-dev-mode-toggle", { timeout: 20_000 }).should("have.attr", "aria-checked", "true");
    cy.get('[data-testid="topbar-back-btn"]').click();
    cy.get('[data-testid="builder-query-preview"]', { timeout: 20_000 }).should("be.visible");
  });

  it("toggles hide empty sequence groups", () => {
    cy.openSpaceTab("settings");
    cy.get("#space-hide-empty-groups-toggle", { timeout: 20_000 })
      .should("not.be.disabled")
      .and("have.attr", "aria-checked", "false")
      .click();
    cy.get("#space-hide-empty-groups-toggle").should("have.attr", "aria-checked", "true");
    cy.get('[data-testid="space-settings-save-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="space-settings-save-btn"]', { timeout: 20_000 }).should(
      "contain.text",
      "Save changes"
    );
    cy.get("#space-hide-empty-groups-toggle", { timeout: 20_000 }).should(
      "have.attr",
      "aria-checked",
      "true"
    );
  });

  it("invites a member on the Users tab", () => {
    cy.openSpaceTab("users");
    cy.inviteMember(SPACE_ADMIN.INVITE_EMAIL);
  });

  it("creates an agent API key on the Agents tab", () => {
    cy.openSpaceTab("agents");
    cy.createAgentKey(SPACE_ADMIN.AGENT_NAME);
  });

  it("stores a credential on the Credentials tab", () => {
    cy.openSpaceTab("credentials");
    cy.upsertCredential(SPACE_ADMIN.CREDENTIAL_NAME, SPACE_ADMIN.CREDENTIAL_VALUE);
    cy.contains(".rbacMemberRow", SPACE_ADMIN.CREDENTIAL_NAME)
      .find(".agentTokenCode code")
      .should("contain.text", `$secret.${SPACE_ADMIN.CREDENTIAL_NAME}`);
  });

  it("shows the read-only audit log", () => {
    cy.openSpaceTab("audit");
    cy.contains(".spaceConfigSection h3", "Audit log").should("be.visible");
    cy.contains(".rbacHeaderRow button", "Refresh").click();
    // Either rows render or the empty-state message is shown — both are valid.
    cy.get(".spaceConfigSection").should(($section) => {
      const text = $section.text();
      expect(text.includes("No sequence runs recorded yet") || text.includes("Run at")).to.eq(
        true
      );
    });
  });
});
