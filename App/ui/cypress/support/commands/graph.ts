/** Slug a graph label for `data-testid` lookup (mirrors GraphView.tsx). */
function graphTestIdSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function graphNodeTestId(group: string, label: string): string {
  return `graph-node-${group.toLowerCase()}-${graphTestIdSlug(label)}`;
}

function graphRelTestId(label: string): string {
  return `graph-rel-${graphTestIdSlug(label)}`;
}

/** Click a node in the D3 force graph by its label group (STEP, INSTANCE, …) and display label. */
Cypress.Commands.add("clickGraphNode", (group: string, label: string) => {
  const testId = graphNodeTestId(group, label);
  cy.get(`[data-testid="${testId}"]`, { timeout: 30_000 }).should("be.visible");
  // The interactive hit target is the main node circle (second circle in the group).
  cy.get(`[data-testid="${testId}"] circle`).eq(1).click({ force: true });
});

/** Click a relationship in the D3 force graph by its display label. */
Cypress.Commands.add("clickGraphRelationship", (label: string) => {
  const testId = graphRelTestId(label);
  cy.get(`[data-testid="${testId}"]`, { timeout: 30_000 }).should("be.visible");
  cy.get(`[data-testid="${testId}"]`).click({ force: true });
});

/** Assert a graph node is painted as schema-drift / out-of-sync (red ring). */
Cypress.Commands.add("expectGraphNodeAffected", (group: string, label: string) => {
  const testId = graphNodeTestId(group, label);
  cy.get(`[data-testid="${testId}"] circle`, { timeout: 30_000 })
    .eq(1)
    .should("have.attr", "stroke-width", "2.5");
});
