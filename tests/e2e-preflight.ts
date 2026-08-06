/**
 * Diagnostic checks for Cypress E2E prerequisites (no browser required).
 * Run: cd App/ui && npm run test:e2e:preflight
 */
import { createRequire } from "node:module";
import path from "path";
import { fileURLToPath } from "url";
import { createClerkSignInTicket, readCypressEnvValue } from "../App/ui/cypress/plugins/clerk-auth.ts";

const require = createRequire(import.meta.url);
const dotenv = require(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../App/ui/node_modules/dotenv"
)) as typeof import("dotenv");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

const CYPRESS_BASE = "http://127.0.0.1:5173";

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${name}: ${message}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  await check("API server reachable", async () => {
    const res = await fetch("http://127.0.0.1:8765/api/spaces");
    if (res.status !== 401 && res.status !== 200) {
      throw new Error(`unexpected status ${res.status} (expected 401 without auth)`);
    }
  });

  await check("Vite E2E dev server on :5173", async () => {
    const res = await fetch(CYPRESS_BASE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await check("CLERK_SECRET_KEY in root .env", async () => {
    if (!process.env.CLERK_SECRET_KEY?.trim()) {
      throw new Error("missing CLERK_SECRET_KEY");
    }
  });

  await check("CLERK_TEST_IDENTIFIER in cypress.env.json", async () => {
    if (!readCypressEnvValue("CLERK_TEST_IDENTIFIER")) {
      throw new Error("missing CLERK_TEST_IDENTIFIER");
    }
  });

  await check("Clerk sign-in ticket (Backend API)", async () => {
    const id = readCypressEnvValue("CLERK_TEST_IDENTIFIER");
    const ticket = await createClerkSignInTicket(id);
    if (!ticket) throw new Error("empty ticket");
  });

  await check("SUPERADMIN_EMAIL matches test user (recommended)", async () => {
    const id = readCypressEnvValue("CLERK_TEST_IDENTIFIER").toLowerCase();
    const superEmail = (process.env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
    if (!superEmail) {
      throw new Error("SUPERADMIN_EMAIL not set — space creation after dev_reset will fail");
    }
    if (superEmail !== id) {
      throw new Error(`SUPERADMIN_EMAIL (${superEmail}) !== CLERK_TEST_IDENTIFIER (${id})`);
    }
  });

  if (process.exitCode) {
    console.log("\nPreflight failed — fix the items above before running Cypress.");
  } else {
    console.log("\nPreflight passed. Run: cd App/ui && npm run test:e2e");
  }
}

void main();
