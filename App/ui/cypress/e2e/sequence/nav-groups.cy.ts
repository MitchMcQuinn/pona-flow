import { NAV_GROUP } from "../../support/constants";

describe("sequence: navigation groups", () => {
  it("creates a new navigation group via the inline control", () => {
    cy.bootstrapApp();

    cy.addNavGroup(NAV_GROUP.EXTRA);
    cy.contains(".navGroupTitle", NAV_GROUP.EXTRA).should("be.visible");
  });

  // Drag-and-drop reorder uses native HTML5 DnD on `.sequenceItem` / `.navGroupHeader`,
  // which Cypress cannot reliably synthesize without a DnD plugin. Tracked in the
  // coverage matrix; enable once a drag helper (e.g. @4tw/cypress-drag-drop) is added.
  it.skip("reorders sequences by dragging (needs DnD helper)", () => {});
});
