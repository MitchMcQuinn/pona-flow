import { E2E_SPACE_ID } from "../../support/constants";

describe("auth & bootstrap", () => {
  it("creates the shared E2E space after sign-in", () => {
    cy.bootstrapApp();
    cy.get("#space-selector").should("be.visible").and("have.value", E2E_SPACE_ID);
  });
});
