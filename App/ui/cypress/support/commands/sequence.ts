import { openAttributiveLabelPicker, scrollConfigBuilderToTop } from "./helpers";

Cypress.Commands.add("openSequenceCreator", () => {
  cy.get('[data-testid="nav-add-sequence"]').click();
  scrollConfigBuilderToTop();
  cy.get('.createSequenceFields input[placeholder="Sequence name"]', { timeout: 20_000 }).should(
    "be.visible"
  );
});

Cypress.Commands.add(
  "createSequenceFromStep",
  (options: { name: string; groupTitle: string; stepLabel: string }) => {
    scrollConfigBuilderToTop();
    openAttributiveLabelPicker();
    cy.get('[data-testid="builder-picker-menu"]')
      .contains("button.builderPickerItem", options.stepLabel)
      .click();

    cy.get('.createSequenceFields input[placeholder="Sequence name"]')
      .clear()
      .type(options.name);

    cy.contains(".createSequenceFields label", "group title")
      .closest(".builderField")
      .find(".builderPickerToggle")
      .click();
    cy.get('[data-testid="builder-picker-menu"]')
      .contains("button.builderPickerCreate", "+ New group title")
      .click();
    cy.get('.createSequenceNewGroup input[placeholder="New group title"]')
      .clear()
      .type(options.groupTitle);

    cy.get('[data-testid="builder-create-sequence-btn"]')
      .scrollIntoView()
      .should("not.be.disabled")
      .click();
    cy.contains(".sequenceBtnLabel", options.name, { timeout: 60_000 }).should("be.visible");
  }
);

Cypress.Commands.add("selectSequenceInNav", (sequenceLabel: string) => {
  cy.contains(".sequenceBtnLabel", sequenceLabel).click();
  cy.contains(".sequenceBtnLabel", sequenceLabel)
    .closest(".sequenceItem")
    .should("have.class", "active");
});

Cypress.Commands.add("runSelectedSequence", () => {
  cy.get('[data-testid="topbar-run-btn"]', { timeout: 60_000 }).should("not.be.disabled");
  cy.get('[data-testid="topbar-run-btn"]').click();
  cy.get('[role="status"].toast--ok', { timeout: 120_000 }).should(
    "contain.text",
    "successful execution"
  );
});
