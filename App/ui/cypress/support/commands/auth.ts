import { setupClerkTestingToken } from "@clerk/testing/cypress";

const APP_HOST = "127.0.0.1";
const APP_PORT = "5173";

export function assertOnAppOrigin(): void {
  cy.location("hostname").should((hostname) => {
    if (hostname.includes("accounts.dev")) {
      throw new Error(
        [
          "Clerk redirected to the hosted Account Portal (" + hostname + ").",
          "Cypress cannot sign in from that origin.",
          "",
          "Fix: stop Vite, then start the E2E dev server:",
          "  cd App/ui && npm run dev:e2e",
          "",
          "Do not use `npm run dev` for Cypress — it enables RedirectToSignIn.",
        ].join("\n")
      );
    }
    expect(hostname).to.eq(APP_HOST);
  });
  cy.location("port").should("eq", APP_PORT);
}

function assertE2eAuthModeEnabled(): void {
  cy.get("[data-e2e-auth-shell]", { timeout: 20_000 }).should("exist");
}

function failIfMissingTestIdentifier(): void {
  const identifier = (Cypress.env("CLERK_TEST_IDENTIFIER") as string | undefined)?.trim();
  if (!identifier) {
    throw new Error(
      [
        "Missing CLERK_TEST_IDENTIFIER in App/ui/cypress.env.json.",
        "Set it to the email of your Clerk E2E test user.",
        "Also ensure CLERK_SECRET_KEY is in the repo root .env and SUPERADMIN_EMAIL",
        "matches the test user so they can create spaces after dev_reset.",
      ].join("\n")
    );
  }
}

Cypress.Commands.add("resetDevState", () => {
  cy.task("resetDevData", null, { timeout: 120_000 });
});

Cypress.Commands.add("signInAsTestUser", () => {
  setupClerkTestingToken();

  cy.then(() => {
    failIfMissingTestIdentifier();
  });

  const identifier = (Cypress.env("CLERK_TEST_IDENTIFIER") as string).trim();

  cy.task<string>("createClerkSignInTicket", identifier).as("clerkSignInTicket");

  cy.clearLocalStorage();
  cy.visit("/");
  assertOnAppOrigin();
  assertE2eAuthModeEnabled();

  cy.get<string>("@clerkSignInTicket").then((ticket) => {
    cy.clerkSignIn({ strategy: "ticket", ticket });
  });

  cy.location("hostname").should("eq", APP_HOST);
  cy.visit("/");
  assertOnAppOrigin();
  cy.clerkLoaded();
  cy.get(".appShell", { timeout: 20_000 }).should("be.visible");
});
