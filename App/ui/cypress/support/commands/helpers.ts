/** Open the first attributive_label picker on the builder form. */
export function openAttributiveLabelPicker(): void {
  cy.contains(".builderField label", "attributive_label")
    .first()
    .parent()
    .find(".builderPickerToggle")
    .click();
}

/** Choose an option from the open floating picker menu. */
export function pickFromOpenPicker(optionText: string): void {
  cy.get('[data-testid="builder-picker-menu"]')
    .contains("button.builderPickerItem", optionText)
    .click();
}

/** Open the target picker (INSTANCE create) and choose an action or option. */
export function pickTargetPickerAction(actionLabel: string): void {
  cy.contains(".builderField label", "target")
    .parent()
    .find(".builderPickerToggle")
    .click();
  cy.get('[data-testid="builder-picker-menu"]')
    .contains("button.builderPickerCreate", actionLabel)
    .click();
}

/** Reset scroll on the builder config column (position persists across builder remounts). */
export function scrollConfigBuilderToTop(): void {
  cy.get(".configPanel.builderPanel .panel__body").scrollTo("top");
}
