import {
  GOLDEN_INSTANCE_NAME,
  GOLDEN_READ_OPERATION,
  GOLDEN_SCHEMA_LABEL,
  GOLDEN_SEQUENCE_GROUP,
  GOLDEN_SEQUENCE_NAME
} from "../../support/constants";

describe("visualization: design graph", () => {
  it("renders the step-flow design graph for a selected sequence", () => {
    cy.bootstrapApp();
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);
    cy.openSequenceCreator();
    cy.createSequenceFromStep({
      name: GOLDEN_SEQUENCE_NAME,
      groupTitle: GOLDEN_SEQUENCE_GROUP,
      stepLabel: GOLDEN_READ_OPERATION
    });

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);

    cy.get(".panel.vizPanel", { timeout: 30_000 }).should("be.visible");
    cy.get(".designGraphView", { timeout: 30_000 }).should("be.visible");
    cy.contains(".designGraphView .muted", "Design graph for").should("be.visible");
    cy.get(".designGraphView .graphViewContainer").should("exist");
    cy.get('[data-testid="graph-view-container"]').should("be.visible");
  });

  it("opens the builder when a STEP node in the design graph is clicked", () => {
    cy.bootstrapApp();
    cy.createSchemaNode(GOLDEN_SCHEMA_LABEL, [{ name: "name", isLabel: true }]);
    cy.createInstanceNode(GOLDEN_SCHEMA_LABEL, { name: GOLDEN_INSTANCE_NAME });
    cy.configureReadInstanceMatch(GOLDEN_SCHEMA_LABEL);
    cy.saveBuilderOperation(GOLDEN_READ_OPERATION);
    cy.openSequenceCreator();
    cy.createSequenceFromStep({
      name: GOLDEN_SEQUENCE_NAME,
      groupTitle: GOLDEN_SEQUENCE_GROUP,
      stepLabel: GOLDEN_READ_OPERATION
    });

    cy.selectSequenceInNav(GOLDEN_SEQUENCE_NAME);
    cy.clickGraphNode("STEP", GOLDEN_READ_OPERATION);

    cy.get('[data-testid="builder-save-operation-btn"]', { timeout: 20_000 }).should("be.visible");
  });

  // Custom-endpoint HTTP response view requires creating a custom-endpoint STEP (update/STEP
  // flow with HTTP template). Tracked in the coverage matrix; enable once a command exists.
  it.skip("shows the HTTP response view for a custom-endpoint step", () => {});
});
