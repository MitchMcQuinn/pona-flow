import { openAttributiveLabelPicker, pickFromOpenPicker } from "./helpers";

/** Match SCHEMA property name live-input normalization (UPPER_SNAKE, $param preserved). */
function normalizeSchemaPropertyKey(name: string): string {
  const trimmed = name.trim();
  if (/^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("$")) {
    return "$" + trimmed.slice(1).replace(/[^A-Za-z0-9_]/g, "");
  }
  return trimmed.replace(/\s+/g, "_").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

export interface SchemaPropertySpec {
  name: string;
  isLabel?: boolean;
}

/** Click an option inside a builder segment toggle, then assert it became active. */
function selectSegmentOption(toggleTestId: string, optionValue: string): void {
  cy.get(`[data-testid="${toggleTestId}-option-${optionValue}"]`)
    .should("not.be.disabled")
    .click();
  cy.get(`[data-testid="${toggleTestId}"] button.active`).should(
    "contain.text",
    optionValue
  );
}

Cypress.Commands.add("selectBuilderOperation", (operation: string) => {
  selectSegmentOption("builder-operation-toggle", operation);
});

Cypress.Commands.add("selectBuilderLabel", (label: string) => {
  selectSegmentOption("builder-label-toggle", label);
});

Cypress.Commands.add("selectAttributiveLabelFromPicker", (optionText: string) => {
  openAttributiveLabelPicker();
  pickFromOpenPicker(optionText);
  cy.contains(".builderField label", "attributive_label")
    .first()
    .parent()
    .find(".builderPickerToggle")
    .should("contain.text", optionText);
});

Cypress.Commands.add("addNewAttributiveLabelNode", (attributiveLabel: string) => {
  const normalized = attributiveLabel.trim().toUpperCase();

  openAttributiveLabelPicker();
  cy.get('[data-testid="builder-picker-menu"]')
    .contains("button.builderPickerCreate", "+ ADD NEW NODE")
    .click();

  cy.get('[data-testid="modal-new-step-node"]').should("be.visible");
  cy.get('[data-testid="modal-new-step-node"]')
    .contains("label", "attributive_label")
    .parent()
    .find("input")
    .clear()
    .type(normalized);
  cy.get('[data-testid="modal-new-step-node"] [data-testid="modal-confirm-btn"]').click();
  cy.get('[data-testid="modal-new-step-node"]').should("not.exist");

  cy.contains(".builderField label", "attributive_label")
    .first()
    .parent()
    .find(".builderPickerToggle")
    .should("contain.text", normalized);

  cy.contains(".builderField label", "attributive_label")
    .first()
    .parent()
    .find(".builderCheckMsg.ok", { timeout: 15_000 })
    .should("contain.text", "valid");
});

Cypress.Commands.add(
  "addSchemaProperty",
  (propertyName: string, options: { isLabel?: boolean } = {}) => {
    cy.contains("button", "+ property").click();
    cy.contains("label", "property name")
      .last()
      .parent()
      .find("input")
      .clear()
      .type(propertyName);

    if (options.isLabel) {
      cy.contains(".builderToggleLabel", "is_label")
        .last()
        .parent()
        .find('button[role="switch"]')
        .then(($switch) => {
          if ($switch.attr("aria-checked") !== "true") {
            cy.wrap($switch).click();
          }
        })
        .should("have.attr", "aria-checked", "true");
    }
  }
);

Cypress.Commands.add("runBuilderCreate", () => {
  cy.get('[data-testid="builder-run-btn"]').should("not.be.disabled").click();
  cy.get('[role="status"].toast--ok', { timeout: 60_000 }).should(
    "contain.text",
    "CREATE completed successfully"
  );
});

Cypress.Commands.add(
  "createSchemaNode",
  (attributiveLabel: string, properties: SchemaPropertySpec[] = []) => {
    cy.selectBuilderOperation("create");
    cy.selectBuilderLabel("SCHEMA");
    cy.addNewAttributiveLabelNode(attributiveLabel);

    for (const property of properties) {
      cy.addSchemaProperty(property.name, { isLabel: property.isLabel });
    }

    cy.runBuilderCreate();
  }
);
