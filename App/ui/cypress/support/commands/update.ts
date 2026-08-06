import { openAttributiveLabelPicker, pickFromOpenPicker } from "./helpers";

/**
 * Update an INSTANCE property via the bound SET projection row.
 *
 * Assumes the builder is reset. Selects update/INSTANCE, matches the schema, adds a
 * SET assignment, picks the property, and types the value. The caller runs it via
 * `cy.get('[data-testid="builder-run-btn"]')` (an UPDATE success surfaces as a toast).
 */
Cypress.Commands.add(
  "updateInstanceMatch",
  (schemaLabel: string) => {
    cy.selectBuilderOperation("update");
    cy.selectBuilderLabel("INSTANCE");
    openAttributiveLabelPicker();
    pickFromOpenPicker(schemaLabel);
  }
);

Cypress.Commands.add(
  "setInstanceProperty",
  (propertyName: string, value: string) => {
    cy.contains(".builderSection h3", "Set (update)")
      .closest(".builderSection")
      .within(() => {
        cy.contains("button", "+ assignment").click();
      });

    // Newest assignment row is the last `.builderItemRow` in the SET section.
    cy.contains(".builderSection h3", "Set (update)")
      .closest(".builderSection")
      .find(".builderItemRow")
      .last()
      .within(() => {
        // schema picker — the only path binding for a single-node INSTANCE match.
        cy.contains(".builderField label", "schema")
          .parent()
          .find(".builderPickerToggle")
          .click();
      });
    cy.get('[data-testid="builder-picker-menu"]').find("button.builderPickerItem").first().click();

    cy.contains(".builderSection h3", "Set (update)")
      .closest(".builderSection")
      .find(".builderItemRow")
      .last()
      .within(() => {
        cy.contains(".builderField label", "property")
          .parent()
          .find(".builderPickerToggle")
          .click();
      });
    cy.get('[data-testid="builder-picker-menu"]')
      .contains("button.builderPickerItem", propertyName)
      .click();

    cy.contains(".builderSection h3", "Set (update)")
      .closest(".builderSection")
      .find(".builderItemRow")
      .last()
      .within(() => {
        cy.contains(".builderField label", "value")
          .parent()
          .find("input")
          .clear()
          .type(value);
      });
  }
);

/**
 * Add a property to an existing SCHEMA via the update/SCHEMA entity-config form, then run.
 * Resolves the suspension-impact preview modal when it appears (confirms the update).
 */
Cypress.Commands.add(
  "addSchemaPropertyUpdate",
  (schemaLabel: string, propertyName: string) => {
    cy.selectBuilderOperation("update");
    cy.selectBuilderLabel("SCHEMA");
    openAttributiveLabelPicker();
    pickFromOpenPicker(schemaLabel);

    cy.addSchemaProperty(propertyName);

    cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
  }
);

/** Confirm the schema-update suspension modal if it is shown, then wait for the success toast. */
Cypress.Commands.add("confirmSchemaUpdate", () => {
  cy.get("body").then(($body) => {
    if ($body.find('[data-testid="modal-schema-update-suspend"]').length > 0) {
      cy.get('[data-testid="modal-schema-update-suspend"] [data-testid="modal-confirm-btn"]').click();
      cy.get('[data-testid="modal-schema-update-suspend"]').should("not.exist");
    }
  });
  cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should("contain.text", "updated");
});
