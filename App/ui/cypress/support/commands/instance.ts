import { openAttributiveLabelPicker, pickFromOpenPicker, pickTargetPickerAction } from "./helpers";

/** Match SCHEMA property name live-input normalization (UPPER_SNAKE, $param preserved). */
function normalizeSchemaPropertyKey(name: string): string {
  const trimmed = name.trim();
  if (/^\$(?![0-9])[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  return trimmed.replace(/\s+/g, "_").toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

Cypress.Commands.add(
  "createInstanceNode",
  (schemaLabel: string, propertyValues: Record<string, string>) => {
    cy.selectBuilderOperation("create");
    cy.selectBuilderLabel("INSTANCE");

    openAttributiveLabelPicker();
    pickFromOpenPicker(schemaLabel);

    pickTargetPickerAction("+ NEW INSTANCE");

    for (const [propertyName, value] of Object.entries(propertyValues)) {
      const key = normalizeSchemaPropertyKey(propertyName);
      cy.contains(".builderField .builderMono", key, { timeout: 15_000 })
        .closest(".builderField")
        .find("input, textarea")
        .first()
        .clear()
        .type(value);
    }

    cy.runBuilderCreate();
  }
);
