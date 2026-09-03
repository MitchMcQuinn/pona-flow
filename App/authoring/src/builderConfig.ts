import { newQuery } from "./defaults.js";
import type { AuthoringContext, BuilderConfig } from "./types.js";

/**
 * Capture the declarative builder snapshot persisted alongside a saved operation (the queries
 * catalog `builder_config` column). The composer is forward-only, so this snapshot is what lets
 * an operation-backed STEP be reloaded into the builder for editing. `query` is the QueryObject
 * source of truth; `runtimeEnabled` and canvas positions live outside it and are carried here too.
 */
export function serializeBuilderConfig(
  ctx: Pick<AuthoringContext, "query" | "matchPositions">,
  runtimeEnabled: boolean
): BuilderConfig {
  return {
    version: 1,
    query: ctx.query,
    runtimeEnabled,
    matchPositions: ctx.matchPositions
  };
}

/** True when a stored builder_config object carries a usable QueryObject snapshot. */
export function isHydratableBuilderConfig(
  config: unknown
): config is BuilderConfig {
  if (!config || typeof config !== "object") return false;
  const query = (config as { query?: unknown }).query;
  return Boolean(query) && typeof query === "object";
}

/** Copy a catalog title onto a stored builder snapshot's ``query.name``. */
export function withCatalogQueryName(config: unknown, name: string): unknown {
  if (!isHydratableBuilderConfig(config)) return config;
  return {
    ...config,
    query: { ...config.query, name }
  };
}

/**
 * Synthesize the builder snapshot for a one-step sequence that wraps a single STEP node by
 * its `attributive_label`. Auto-wrapped sequences (see `autoWrapInSequence`) compose their read
 * Cypher straight from a template and never pass through the visual builder, so without this they
 * would persist an empty `builder_config` and refuse to open in the create-sequence editor. The
 * shape mirrors what the builder produces for a STEP-matching read so an edit round-trips cleanly.
 */
export function oneStepSequenceBuilderConfig(
  sequenceId: string,
  attributiveLabel: string
): BuilderConfig {
  const query = newQuery("read");
  query.id = sequenceId;
  const element = query.match[0]?.patterns[0]?.path[0];
  if (element && element.kind === "node") {
    element.node = { ...element.node, attributive_label: attributiveLabel.trim() };
  }
  return { version: 1, query, runtimeEnabled: true, matchPositions: {} };
}
