import { openAttributiveLabelPicker, pickFromOpenPicker } from "./helpers";

Cypress.Commands.add("configureReadInstanceMatch", (schemaLabel: string) => {
  cy.selectBuilderOperation("read");
  cy.selectBuilderLabel("INSTANCE");
  openAttributiveLabelPicker();
  pickFromOpenPicker(schemaLabel);
});

/**
 * Extend a read/INSTANCE match with a WHERE filter whose value is a `$param` reference.
 * The parameter is auto-discovered by the builder when the filter is committed.
 */
Cypress.Commands.add(
  "configureReadInstanceParamFilter",
  (options: { property: string; paramName: string }) => {
    cy.contains("button", "+ filter").first().click();

    cy.contains(".builderItemRow label", "property")
      .last()
      .parent()
      .find("select")
      .should("not.be.disabled")
      .select(options.property);

    cy.contains(".builderItemRow label", "value")
      .last()
      .parent()
      .find("select")
      .select("+ Parameter");

    cy.contains(".builderItemRow label", "value")
      .last()
      .parent()
      .find('input[placeholder="$param"]')
      .clear()
      .type(`$${options.paramName}`)
      .blur();
  }
);

Cypress.Commands.add(
  "saveBuilderOperation",
  (operationName: string, groupTitle = "E2E Golden Path") => {
    cy.get('[data-testid="builder-create-operation-btn"]').should("not.be.disabled").click();
    cy.get('[data-testid="modal-create-operation"]').should("be.visible");
    cy.get('[data-testid="modal-create-operation"]')
      .contains("label", "name")
      .parent()
      .find("input")
      .clear()
      .type(operationName);

    cy.get('[data-testid="modal-create-operation"]')
      .contains("label", "group title")
      .closest(".builderField")
      .find(".builderPickerToggle")
      .click();
    cy.get('[data-testid="builder-picker-menu"]')
      .contains("button.builderPickerCreate", "+ New group title")
      .click();
    cy.get('[data-testid="modal-create-operation"] input[placeholder="New group title"]')
      .clear()
      .type(groupTitle);

    cy.get('[data-testid="modal-create-operation"] [data-testid="modal-confirm-btn"]').click();
    cy.get('[data-testid="modal-create-operation"]').should("not.exist");
    cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
      "contain.text",
      "Operation saved to catalog"
    );
  }
);
