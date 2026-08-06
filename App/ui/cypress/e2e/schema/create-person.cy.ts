describe("schema", () => {
  beforeEach(() => {
    cy.bootstrapApp();
  });

  it("creates a PERSON schema with a name property flagged as is_label", () => {
    cy.createSchemaNode("PERSON", [{ name: "name", isLabel: true }]);

    cy.selectBuilderOperation("read");
    cy.selectBuilderLabel("SCHEMA");
    cy.contains(".builderField label", "attributive_label")
      .first()
      .parent()
      .find(".builderPickerToggle")
      .click();
    cy.get(".builderPickerMenu")
      .contains("button.builderPickerItem", "PERSON")
      .should("be.visible");
  });
});
