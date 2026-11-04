import { E2E_SPACE_ID } from "../../support/constants";

describe("space: single workspace", () => {
  it("shows the workspace name and does not offer another space", () => {
    cy.bootstrapApp();
    cy.get("#space-selector").should("be.visible").and("have.attr", "data-space-id", E2E_SPACE_ID);
    cy.get('[data-testid="nav-create-space"]').should("not.exist");
    cy.get('[data-testid="space-selector-menu"]').should("not.exist");

    cy.openSpaceSettings();
    cy.openSpaceTab("settings");
    cy.get('[data-testid="space-delete-btn"]').should("not.exist");
    cy.get('[data-testid="space-settings-save-btn"]').should("be.visible");
  });
});
