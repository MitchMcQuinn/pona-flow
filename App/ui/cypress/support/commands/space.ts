import { E2E_SPACE_DISPLAY_NAME } from "../constants";

function normalizeSpaceName(raw: string): string {
  let text = raw.trim().toUpperCase().replace(/\s+/g, "_");
  text = text.replace(/[^A-Z0-9_]/g, "");
  return text.replace(/_+/g, "_").replace(/^_|_$/g, "");
}

Cypress.Commands.add("createSpace", (name: string) => {
  const spaceId = normalizeSpaceName(name);
  cy.get('[data-testid="modal-create-space"]', { timeout: 20_000 }).should("be.visible");
  cy.get('[data-testid="modal-create-space"]')
    .contains("label", "name")
    .parent()
    .find("input")
    .clear()
    .type(name);
  cy.get('[data-testid="modal-create-space"] [data-testid="modal-confirm-btn"]')
    .should("not.be.disabled")
    .click();
  cy.get('[data-testid="modal-create-space"]').should("not.exist");
  cy.get("#space-selector").should("have.value", spaceId);
  cy.get(`#space-selector option[value="${spaceId}"]`).should("exist");
});

/** Create the shared E2E space and wait until the builder is ready for mutations. */
Cypress.Commands.add("bootstrapApp", () => {
  cy.createSpace(E2E_SPACE_DISPLAY_NAME);
  cy.get("#builder-operation-label", { timeout: 20_000 }).should("be.visible");
  cy.get("#builder-label-label").should("be.visible");
});

type SpaceTab = "settings" | "users" | "agents" | "credentials" | "templates" | "audit";

/** Switch to a space-config tab (assumes the space panel is already open). */
Cypress.Commands.add("openSpaceTab", (tab: SpaceTab) => {
  cy.get(`[data-testid="space-tab-${tab}"]`).click();
  cy.get(`[data-testid="space-tab-${tab}"]`).should("have.class", "active");
});

/** Invite a member by email on the open Users tab and wait for it to appear. */
Cypress.Commands.add("inviteMember", (email: string) => {
  cy.get('.rbacInviteRow input[type="email"]').clear().type(email);
  cy.get(".rbacInviteRow").contains("button", "Invite").should("not.be.disabled").click();
  cy.contains(".rbacMemberRow", email, { timeout: 20_000 }).should("be.visible");
});

/** Create an agent API key on the open Agents tab; resolves the one-time token modal. */
Cypress.Commands.add("createAgentKey", (name: string) => {
  cy.get('.rbacInviteRow input[placeholder="New agent name"]').clear().type(name);
  cy.get(".rbacInviteRow").contains("button", "Create key").should("not.be.disabled").click();
  cy.get('[data-testid="modal-agent-key"]', { timeout: 20_000 }).should("be.visible");
  cy.get('[data-testid="modal-agent-key"] [data-testid="modal-confirm-btn"]').click();
  cy.get('[data-testid="modal-agent-key"]').should("not.exist");
  cy.contains(".rbacMemberRow", name).should("be.visible");
});

/** Upsert a credential on the open Credentials tab and wait for it to be listed. */
Cypress.Commands.add("upsertCredential", (name: string, value: string) => {
  cy.get('.rbacInviteRow input[placeholder^="Name"]').clear().type(name);
  cy.get('.rbacInviteRow input[type="password"]').then(($input) => {
    if (!$input.prop("disabled")) cy.wrap($input).clear().type(value);
  });
  cy.get(".rbacInviteRow").contains("button", "Save credential").should("not.be.disabled").click();
  cy.contains(".rbacMemberRow", name, { timeout: 20_000 }).should("be.visible");
});
