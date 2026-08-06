/** Shared E2E constants — keep in sync with catalog space name normalization. */
export const E2E_SPACE_DISPLAY_NAME = "clerk test space";
/** Catalog id for {@link E2E_SPACE_DISPLAY_NAME} (`normalizeSpaceName`). */
export const E2E_SPACE_ID = "CLERK_TEST_SPACE";

/** Golden-path journey fixtures (schema → instance → step → sequence → run). */
export const GOLDEN_SCHEMA_LABEL = "PERSON";
export const GOLDEN_INSTANCE_NAME = "Alice";
export const GOLDEN_READ_OPERATION = "READ_PERSON";
export const GOLDEN_SEQUENCE_NAME = "PERSON_INSTANCE_FLOW";
export const GOLDEN_SEQUENCE_GROUP = "E2E Golden Path";

/**
 * Per-domain fixtures shared across the broader spec suite. Keep labels uppercase
 * (they become attributive_labels / STEP labels) and distinct from the golden-path
 * fixtures so specs that build on a fresh space never collide.
 */
export const SCHEMA = {
  /** A second schema used for update/delete cascade specs. */
  COMPANY_LABEL: "COMPANY",
  COMPANY_PROPS: { name: "NAME", founded: "FOUNDED" }
} as const;

export const INSTANCE = {
  COMPANY_NAME: "Acme"
} as const;

export const SEQUENCE = {
  GROUP: "E2E Suite",
  READ_OPERATION: "READ_COMPANY",
  NAME: "COMPANY_INSTANCE_FLOW"
} as const;

export const EVENTS = {
  TIME_NAME: "E2E Weekday Morning",
  EXTERNAL_NAME: "E2E Inbound Webhook",
  EXTERNAL_SECRET: "e2e-shared-secret"
} as const;

export const SPACE_ADMIN = {
  INVITE_EMAIL: "e2e-invitee@example.com",
  ROLE_NAME: "E2E Viewer",
  AGENT_NAME: "E2E Agent",
  CREDENTIAL_NAME: "E2E_API_KEY",
  CREDENTIAL_VALUE: "sk-e2e-test-value"
} as const;

export const NAV_GROUP = {
  EXTRA: "E2E Extra Group"
} as const;

/** Human-in-the-loop (progressive parameter) fixtures. */
export const HITL = {
  PARAM_NAME: "NAME",
  READ_OPERATION: "READ_PERSON_BY_NAME",
  SEQUENCE_NAME: "PERSON_PARAM_FLOW",
  SEQUENCE_GROUP: "E2E HITL"
} as const;
