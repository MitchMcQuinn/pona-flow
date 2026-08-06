import { addClerkCommands } from "@clerk/testing/cypress";
import "./commands";

addClerkCommands({ Cypress, cy });

beforeEach(() => {
  cy.resetDevState();
  cy.signInAsTestUser();
});
