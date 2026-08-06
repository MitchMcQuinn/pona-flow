import { clerkSetup } from "@clerk/testing/cypress";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { defineConfig } from "cypress";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClerkSignInTicket } from "./cypress/plugins/clerk-auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(rootDir, ".env") });

if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

const missingClerkSetup: string[] = [];
if (!process.env.CLERK_PUBLISHABLE_KEY) {
  missingClerkSetup.push("CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY");
}
if (!process.env.CLERK_SECRET_KEY) {
  missingClerkSetup.push("CLERK_SECRET_KEY");
}
if (missingClerkSetup.length > 0) {
  console.warn(
    `[cypress] Clerk testing is not fully configured (${missingClerkSetup.join(", ")}). ` +
      "cy.clerkSignIn() will fail until these are set in the repo root .env or App/ui/.env."
  );
}

function resolvePython(): string {
  const venvPython = path.join(rootDir, ".venv/bin/python");
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export default defineConfig({
  e2e: {
    baseUrl: "http://127.0.0.1:5173",
    setupNodeEvents(on, config) {
      on("task", {
        resetDevData() {
          const python = resolvePython();
          const script = path.join(rootDir, "tools/dev_reset.py");
          try {
            const output = execFileSync(python, [script, "--confirm"], {
              cwd: rootDir,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
            console.log(output.trim());
            return null;
          } catch (error) {
            const err = error as NodeJS.ErrnoException & {
              stdout?: string;
              stderr?: string;
            };
            const detail = [err.stderr, err.stdout].filter(Boolean).join("\n").trim();
            const message = detail || err.message || String(error);
            throw new Error(`dev_reset.py failed (python=${python}): ${message}`);
          }
        },
        async createClerkSignInTicket(identifier: string) {
          try {
            return await createClerkSignInTicket(identifier);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Clerk sign-in ticket failed: ${message}`);
          }
        },
      });
      return clerkSetup({ config });
    },
    supportFile: "cypress/support/e2e.ts",
    specPattern: "cypress/e2e/**/*.cy.{js,jsx,ts,tsx}",
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 15_000,
  },
});
