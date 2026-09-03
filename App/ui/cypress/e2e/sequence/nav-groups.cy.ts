import { NAV_GROUP } from "../../support/constants";

describe("sequence: navigation groups", () => {
  it("creates a new navigation group via the inline control", () => {
    cy.bootstrapApp();

    cy.addNavGroup(NAV_GROUP.EXTRA);
    cy.contains(".navGroupTitle", NAV_GROUP.EXTRA).should("be.visible");
  });

  it("hides empty sequence groups when the space setting is on", () => {
    cy.bootstrapApp();

    cy.addNavGroup(NAV_GROUP.EXTRA);
    cy.contains(".navGroupTitle", NAV_GROUP.EXTRA).should("be.visible");

    cy.openSpaceSettings();
    cy.get("#space-hide-empty-groups-toggle", { timeout: 20_000 })
      .should("not.be.disabled")
      .click();
    cy.get('[data-testid="space-settings-save-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="space-settings-save-btn"]', { timeout: 20_000 }).should(
      "contain.text",
      "Save changes"
    );
    cy.get('[data-testid="topbar-back-btn"]').click();
    cy.contains(".navGroupTitle", NAV_GROUP.EXTRA, { timeout: 20_000 }).should("not.exist");
  });

  // Drag-and-drop reorder uses native HTML5 DnD on `.sequenceItem` / `.navGroupHeader`,
  // which Cypress cannot reliably synthesize without a DnD plugin. Tracked in the
  // coverage matrix; enable once a drag helper (e.g. @4tw/cypress-drag-drop) is added.
  it.skip("reorders sequences by dragging (needs DnD helper)", () => {});
});
