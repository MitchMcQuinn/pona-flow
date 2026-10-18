import { E2E_SPACE_DISPLAY_NAME } from "../../support/constants";

/**
 * Phone (iphone-x) and tablet (ipad-2) layouts. Touch-only affordances (always-visible row
 * actions, the Reorder toggle) key off `(pointer: coarse)` / `(hover: none)`, which a plain
 * Cypress viewport doesn't change — so Chromium touch emulation is switched on via CDP.
 */

const GROUP_A = "E2E Mobile A";
const GROUP_B = "E2E Mobile B";

function setTouchEmulation(enabled: boolean): Cypress.Chainable<unknown> {
  return cy.wrap(
    Cypress.automation("remote:debugger:protocol", {
      command: "Emulation.setTouchEmulationEnabled",
      params: enabled ? { enabled: true, maxTouchPoints: 1 } : { enabled: false }
    }),
    { log: false }
  );
}

function enableTouch(): void {
  setTouchEmulation(true);
  // Reload so media queries and useViewport() start from the coarse pointer.
  cy.reload();
  cy.get(".appShell", { timeout: 20_000 }).should("be.visible");
}

function expectPane(pane: "menu" | "workbench" | "map"): void {
  cy.get("main.layoutResizable").should("have.class", `layoutPane-${pane}`);
  cy.get(`[data-testid="mobile-tab-${pane}"]`).should("have.attr", "aria-current", "page");
}

describe("mobile layout", () => {
  before(function () {
    if (Cypress.browser.family !== "chromium") this.skip();
  });

  afterEach(() => {
    setTouchEmulation(false);
  });

  it("phone: tabs, pane follow, bottom-sheet modals, touch reorder, and the tour", () => {
    cy.viewport("iphone-x");
    enableTouch();

    // First-run create-space modal rises as a full-width bottom sheet that scrolls inside.
    cy.get('[data-testid="modal-create-space"]', { timeout: 20_000 })
      .should("be.visible")
      .then(($panel) => {
        const rect = $panel[0].getBoundingClientRect();
        const win = $panel[0].ownerDocument.defaultView as Window;
        expect(rect.width, "sheet spans the screen").to.be.closeTo(win.innerWidth, 1);
        expect(rect.bottom, "sheet sits on the bottom edge").to.be.closeTo(win.innerHeight, 1);
        expect(win.getComputedStyle($panel[0]).overflowY).to.eq("auto");
      });
    cy.createSpace(E2E_SPACE_DISPLAY_NAME);

    cy.get('[data-testid="mobile-tab-menu"]').should("be.visible");
    cy.get('[data-testid="topbar-nav-toggle"]').should("not.exist");
    expectPane("menu");

    // Tabs switch panes; the builder stays mounted (state survives).
    cy.get('[data-testid="mobile-tab-workbench"]').click();
    expectPane("workbench");
    cy.get("#builder-operation-label").should("be.visible");
    cy.get('[data-testid="mobile-tab-map"]').click();
    expectPane("map");
    cy.get('[data-testid="mobile-tab-menu"]').click();
    expectPane("menu");

    // Opening something from the menu follows it to the workbench.
    cy.get('[data-testid="nav-add-sequence"]').click();
    expectPane("workbench");
    cy.get('[data-testid="mobile-tab-menu"]').click();

    // Touch: group actions are visible without hover; Reorder swaps them for arrows.
    cy.addNavGroup(GROUP_A);
    cy.addNavGroup(GROUP_B);
    cy.get(`[aria-label="Delete group ${GROUP_A}"]`).should("be.visible");
    cy.get(".navGroupDragHandle").should("not.exist");

    cy.get('[data-testid="nav-reorder-toggle"]').should("contain.text", "Reorder").click();
    cy.get(`[aria-label="Delete group ${GROUP_A}"]`).should("not.exist");
    cy.get(`[aria-label="Move group ${GROUP_A} up"]`).should("be.disabled");
    cy.get(`[aria-label="Move group ${GROUP_A} down"]`).should("not.be.disabled").click();
    cy.get(".navGroupTitle").then(($titles) => {
      const order = [...$titles].map((el) => el.textContent?.trim());
      expect(order.indexOf(GROUP_B)).to.be.lessThan(order.indexOf(GROUP_A));
    });
    cy.get('[data-testid="nav-reorder-toggle"]').should("contain.text", "Done").click();
    cy.get(`[aria-label="Delete group ${GROUP_A}"]`).should("be.visible");

    // Replay the tour from Space settings: the card is a sheet clear of the spotlight.
    cy.openSpaceSettings();
    expectPane("workbench");
    cy.get('[data-testid="space-start-tour-btn"]').click();
    cy.get('[data-testid="product-tour"]').should("be.visible");
    cy.get('[data-testid="tour-card"]').should("have.attr", "data-sheet", "bottom");
    cy.get('[data-testid="tour-next"]').click();
    cy.get('[data-testid="tour-next"]').click();
    // The "phone-tabs" step spotlights the bottom tab bar, so the sheet moves to the top.
    cy.get('[data-testid="tour-card"]').should("have.attr", "data-sheet", "top");
    cy.get('[data-testid="tour-skip"]').click();
    cy.get('[data-testid="product-tour"]').should("not.exist");
  });

  it("tablet: navigation is a slide-out drawer", () => {
    cy.viewport("ipad-2");
    enableTouch();
    cy.createSpace(E2E_SPACE_DISPLAY_NAME);

    cy.get('[data-testid="mobile-tab-menu"]').should("not.exist");
    cy.get("main.layoutResizable").should("have.class", "layoutMode-tablet");
    cy.get("main.layoutResizable").should("not.have.class", "layoutNavDrawerOpen");

    cy.get('[data-testid="topbar-nav-toggle"]').should("be.visible").click();
    cy.get("main.layoutResizable").should("have.class", "layoutNavDrawerOpen");
    cy.get('[data-testid="nav-drawer-scrim"]').click({ force: true });
    cy.get("main.layoutResizable").should("not.have.class", "layoutNavDrawerOpen");

    // Picking something in the drawer closes it.
    cy.get('[data-testid="topbar-nav-toggle"]').click();
    cy.get('[data-testid="nav-add-sequence"]').click();
    cy.get("main.layoutResizable").should("not.have.class", "layoutNavDrawerOpen");
  });
});
