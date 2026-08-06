import { createClerkClient } from "@clerk/backend";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "../..");

export function readCypressEnvValue(key: string): string {
  const fromProcess = process.env[`CYPRESS_${key}`]?.trim();
  if (fromProcess) return fromProcess;

  const envFile = path.join(uiDir, "cypress.env.json");
  try {
    const parsed = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    return (parsed[key] ?? "").trim();
  } catch {
    return "";
  }
}

export async function createClerkSignInTicket(identifier: string): Promise<string> {
  const email = identifier.trim();
  if (!email) {
    throw new Error("CLERK_TEST_IDENTIFIER is required (set it in App/ui/cypress.env.json).");
  }

  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required in the repo root .env for E2E sign-in.");
  }

  const clerk = createClerkClient({ secretKey });
  const users = await clerk.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];
  if (!user) {
    throw new Error(`No Clerk user found for ${email}. Create the user in the Clerk dashboard first.`);
  }

  const signInToken = await clerk.signInTokens.createSignInToken({
    userId: user.id,
    expiresInSeconds: 120,
  });

  return signInToken.token;
}
