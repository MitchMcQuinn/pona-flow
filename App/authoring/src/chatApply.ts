/**
 * Apply a chat proposal's builder items through the same saves the visual builder uses.
 *
 * The in-app agent submits flat intents. This module compiles them and persists them
 * with saveQueryOperation, publishCreatedStepAsSequence, runCreate, and the sequence
 * package functions. The Python accept path does not write these rows.
 */

import { connector } from "@pona-flow/connector";
import {
  collectCreateEntityIds,
  collectStepCreateAttributiveLabels,
  DEFAULT_STEP_RELATIONSHIP_LABEL,
} from "./attributiveLabels.js";
import {
  buildLoopConfig,
  buildOperationQuery,
  buildSequenceQuery,
  buildStepTransitionQuery,
  mintedIdCount,
  type LoopIntent,
  type OperationIntent,
  type SchemaPropertyIntent,
  type SequenceIntent,
} from "./intent.js";
import { normalizeAttributiveLabel } from "./normalizeField.js";
import {
  publishCreatedStepAsSequence,
  runCreate,
  saveQueryOperation,
  updateQueryOperation,
} from "./operations.js";
import { assertPreflightClear } from "./preflight.js";
import {
  parseSequenceParameterValues,
  saveSequencePackage,
  serializeSequenceParameterValues,
  updateSequencePackage,
  type SequenceParameterValue,
} from "./sequences.js";
import type { AuthoringContext, BuilderConfig, ConditionType, QueryObject } from "./types.js";
import { isSingleNewStepCreate, isStepCreateQuery } from "./validation.js";

export interface ChatIntentItem {
  kind: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface ChatIntentApplied {
  kind: string;
  summary: string;
  id: string | null;
}

export interface ChatIntentFailure {
  kind: string;
  summary: string;
  error: string;
}

export interface ChatIntentResult {
  ok: boolean;
  applied: ChatIntentApplied[];
  failed: ChatIntentFailure | null;
  not_applied: Array<{ kind: string; summary: string }>;
}

export interface ChatIntentPreview {
  query: QueryObject;
  name: string;
  description: string;
  sequence: boolean;
}

const AUTHORING = new Set(["upsert_schema", "upsert_query", "create_transition"]);

export function isChatAuthoringKind(kind: string): boolean {
  return AUTHORING.has(kind);
}

function payloadOf(item: ChatIntentItem): Record<string, unknown> {
  return item.payload && typeof item.payload === "object" ? item.payload : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summaryOf(item: ChatIntentItem): string {
  return text(item.summary) || text(payloadOf(item).name) || item.kind;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function schemaPropertiesFrom(raw: unknown): SchemaPropertyIntent[] {
  if (!Array.isArray(raw)) return [];
  const properties: SchemaPropertyIntent[] = [];
  for (const entry of raw) {
    const object = asRecord(entry);
    if (!object) continue;
    const source = asRecord(object.property_schema) ?? object;
    const key = text(source.key) || text(source.name);
    if (!key || key.toLowerCase() === "id") continue;
    const options = Array.isArray(source.options)
      ? source.options.map((option) => String(option))
      : undefined;
    properties.push({
      key,
      value_type: text(source.value_type) || undefined,
      format: text(source.format) || undefined,
      is_required: Boolean(source.is_required),
      is_key: Boolean(source.is_key),
      is_label: Boolean(source.is_label),
      is_indexed: Boolean(source.is_indexed),
      is_embedded: Boolean(source.is_embedded),
      default_value: source.default_value == null ? undefined : String(source.default_value),
      options,
    });
  }
  return properties;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function operationIntent(payload: Record<string, unknown>, name: string): OperationIntent {
  const http = asRecord(payload.http_step);
  const wait = asRecord(payload.wait_step);
  const operationStep = asRecord(payload.operation_step);
  const vector = asRecord(payload.vector_search);
  const unwind = asRecord(payload.unwind);
  const properties =
    schemaPropertiesFrom(payload.schema_properties).length > 0
      ? schemaPropertiesFrom(payload.schema_properties)
      : schemaPropertiesFrom(payload.properties);
  const intent: OperationIntent = {
    name,
    operation: text(payload.operation).toLowerCase() as OperationIntent["operation"],
    node_label: text(payload.node_label).toUpperCase() as OperationIntent["node_label"],
    attributive_label: text(payload.attributive_label) || undefined,
    schema_properties: properties,
    is_vectorized: Boolean(payload.is_vectorized),
    instance_properties: Array.isArray(payload.instance_properties)
      ? payload.instance_properties.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row) return [];
          const key = text(row.key) || text(row.name);
          if (!key) return [];
          return [{ key, value: row.value == null ? "" : String(row.value) }];
        })
      : undefined,
    where: Array.isArray(payload.where)
      ? payload.where.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row || !text(row.property_key)) return [];
          return [
            {
              property_key: text(row.property_key),
              operator: text(row.operator) || undefined,
              value: row.value == null ? undefined : String(row.value),
            },
          ];
        })
      : undefined,
    return_items: Array.isArray(payload.return_items)
      ? payload.return_items.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row || !text(row.expression)) return [];
          return [{ expression: text(row.expression), alias: text(row.alias) || undefined }];
        })
      : undefined,
    set_expressions: stringList(payload.set_expressions),
    delete_targets: stringList(payload.delete_targets),
    parameters: Array.isArray(payload.parameters)
      ? payload.parameters.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row || !text(row.name)) return [];
          return [
            {
              name: text(row.name),
              value_type: text(row.value_type) || undefined,
              value: row.value == null ? undefined : String(row.value),
              is_required: Boolean(row.is_required),
            },
          ];
        })
      : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
  };
  if (http) {
    intent.http_step = {
      endpoint: text(http.endpoint),
      method: text(http.method) as NonNullable<OperationIntent["http_step"]>["method"],
      body: asRecord(http.body) ?? undefined,
      headers: asRecord(http.headers) ?? undefined,
      response_parameters: Array.isArray(http.response_parameters)
        ? http.response_parameters.flatMap((entry) => {
            const row = asRecord(entry);
            if (!row) return [];
            return [
              {
                property_path: text(row.property_path),
                parameter: text(row.parameter),
                default_value: text(row.default_value) || undefined,
              },
            ];
          })
        : undefined,
      timeout_seconds: http.timeout_seconds as number | string | undefined,
      max_attempts: typeof http.max_attempts === "number" ? http.max_attempts : undefined,
      backoff_seconds: http.backoff_seconds as number | string | undefined,
    };
  }
  if (wait) {
    intent.wait_step = {
      mode: text(wait.mode) as NonNullable<OperationIntent["wait_step"]>["mode"],
      duration_seconds: wait.duration_seconds as number | string | undefined,
      until: text(wait.until) || undefined,
      event_id: text(wait.event_id) || undefined,
    };
  }
  if (payload.join_step && typeof payload.join_step === "object") intent.join_step = {};
  if (operationStep) {
    intent.operation_step = operationStep as unknown as OperationIntent["operation_step"];
  }
  if (unwind) {
    intent.unwind = {
      alias: text(unwind.alias),
      expressions: stringList(unwind.expressions),
    };
  }
  if (vector) {
    intent.vector_search = {
      enabled: vector.enabled !== false,
      text: text(vector.text) || undefined,
      k: vector.k as number | string | undefined,
      all_labels: vector.all_labels === true,
    };
  }
  return intent;
}

function schemaIntent(payload: Record<string, unknown>): OperationIntent {
  const label = text(payload.attributive_label) || text(payload.name);
  return {
    name: text(payload.name) || label,
    operation: "create",
    node_label: "SCHEMA",
    attributive_label: label,
    schema_properties: schemaPropertiesFrom(payload.properties ?? payload.schema_properties),
    is_vectorized: Boolean(payload.is_vectorized),
  };
}

function loopIntent(raw: unknown): LoopIntent | undefined {
  const loop = asRecord(raw);
  if (!loop) return undefined;
  const condition = asRecord(loop.condition);
  return {
    type: text(loop.type) || undefined,
    count: typeof loop.count === "number" ? loop.count : undefined,
    condition: condition
      ? {
          parameter: text(condition.parameter),
          operator: text(condition.operator),
          value: condition.value == null ? "" : String(condition.value),
        }
      : undefined,
    source: text(loop.source) || undefined,
    max_iterations: typeof loop.max_iterations === "number" ? loop.max_iterations : undefined,
    delay_seconds: typeof loop.delay_seconds === "number" ? loop.delay_seconds : undefined,
    collect: Array.isArray(loop.collect)
      ? loop.collect.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row) return [];
          return [{ from: text(row.from), as: text(row.as), reduce: text(row.reduce) || undefined }];
        })
      : undefined,
  };
}

function rank(item: ChatIntentItem): number {
  if (item.kind === "upsert_schema") return 0;
  if (item.kind === "upsert_query" && text(payloadOf(item).kind) === "sequence") return 3;
  if (item.kind === "upsert_query") return 1;
  if (item.kind === "create_transition") return 2;
  return 9;
}

async function mintIds(count: number): Promise<{ queryId: string; entityIds: string[] }> {
  const queryId = await connector.generateQueryId();
  const entityIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    entityIds.push(await connector.generateQueryId());
  }
  return { queryId, entityIds };
}

async function stepIdForLabel(spaceId: string, attributiveLabel: string): Promise<string> {
  const label = attributiveLabel.trim();
  const nodes = await connector.fetchGraphNodesByLabel({
    spaceId,
    nodeLabel: "STEP",
    attributiveLabel: label,
  });
  const wanted = normalizeAttributiveLabel(label);
  const match =
    nodes.find((node) => node.attributive_label === label) ??
    nodes.find(
      (node) => Boolean(wanted) && normalizeAttributiveLabel(node.attributive_label || "") === wanted
    );
  if (!match) {
    throw new Error(
      `No STEP node named "${label}" exists in this space. Create the step before linking it.`
    );
  }
  return match.id;
}

async function loadPackage(id: string) {
  const trimmed = id.trim();
  if (!trimmed) return null;
  try {
    return await connector.fetchQueryPackage(trimmed);
  } catch {
    return null;
  }
}

function entryStepFrom(query: QueryObject | undefined, cypher: string[] | string | undefined): string {
  const fromSnapshot = query?.match?.[0]?.patterns?.[0]?.path?.[0];
  if (fromSnapshot?.kind === "node") {
    const label = (fromSnapshot.node.attributive_label || "").trim();
    if (label) return label;
  }
  const statements = typeof cypher === "string" ? [cypher] : cypher || [];
  for (const statement of statements) {
    const match = /:STEP\s*\{[^}]*?attributive_label\s*:\s*['"]([^'"]+)['"]/i.exec(String(statement ?? ""));
    if (match) return match[1].trim();
  }
  return "";
}

async function assertSequenceBindings(
  spaceId: string,
  bindings: SequenceParameterValue[],
  opts: { sequenceId?: string; entryStep?: string; traversal?: "single" | "downstream" }
): Promise<SequenceParameterValue[]> {
  const serialized = serializeSequenceParameterValues(bindings);
  if (!serialized.length) return [];
  const preview = await connector.previewSequenceParameters({
    spaceId,
    sequenceId: opts.sequenceId,
    entryStep: opts.entryStep,
    traversal: opts.traversal,
  });
  const allowed = new Set(
    preview.parameters.map((param) => String(param.name || "").trim()).filter(Boolean)
  );
  const unknown = serialized.filter((binding) => !allowed.has(binding.name));
  if (unknown.length) {
    const available = [...allowed].sort().join(", ") || "(none)";
    const names = unknown.map((binding) => binding.name).join(", ");
    throw new Error(
      `Unknown sequence parameter${unknown.length > 1 ? "s" : ""}: ${names}. Bindable inputs on this chain: ${available}.`
    );
  }
  return serialized;
}

function bindingsFrom(raw: unknown): SequenceParameterValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || !text(row.name)) return [];
    return [{ name: text(row.name), value: row.value }];
  });
}

/** Compile one proposal item into the QueryObject the builder preview shows. */
export function previewChatIntent(item: ChatIntentItem): ChatIntentPreview | null {
  if (!isChatAuthoringKind(item.kind)) return null;
  const payload = payloadOf(item);
  if (item.kind === "upsert_schema") {
    const intent = schemaIntent(payload);
    if (!intent.attributive_label) throw new Error("A schema needs attributive_label.");
    const query = buildOperationQuery(intent, { queryId: "preview", entityIds: ["preview-entity"] });
    return { query, name: intent.name, description: text(payload.description), sequence: false };
  }
  if (item.kind === "create_transition") {
    const from = text(payload.from_step);
    const to = text(payload.to_step);
    if (!from || !to) throw new Error("A transition needs from_step and to_step.");
    const query = buildStepTransitionQuery(
      {
        from: { id: "preview-from", attributive_label: from },
        to: { id: "preview-to", attributive_label: to },
        relationship_label: text(payload.relationship_label) || DEFAULT_STEP_RELATIONSHIP_LABEL,
        condition: text(payload.condition) || undefined,
        condition_type: (text(payload.condition_type) || "null") as ConditionType,
        condition_expected:
          typeof payload.condition_expected === "boolean" ? payload.condition_expected : undefined,
      },
      { queryId: "preview", entityIds: ["preview-rel"] }
    );
    return { query, name: `${from} -> ${to}`, description: "", sequence: false };
  }
  const kind = text(payload.kind).toLowerCase() || "operation";
  if (kind === "sequence") {
    const entry = text(payload.entry_step);
    if (!entry) throw new Error("A sequence needs entry_step, the STEP it starts at.");
    const traversal = text(payload.traversal).toLowerCase() === "single" ? "single" : "downstream";
    const query = buildSequenceQuery({
      id: text(payload.id) || "preview",
      entry_step: entry,
      traversal,
    } satisfies SequenceIntent);
    return {
      query,
      name: text(payload.name) || entry,
      description: text(payload.description),
      sequence: true,
    };
  }
  const name = text(payload.name);
  if (!name) throw new Error("An operation needs a name.");
  if (!text(payload.operation) || !text(payload.node_label)) {
    throw new Error("An operation needs operation and node_label.");
  }
  const intent = operationIntent(payload, name);
  if (intent.node_label === "STEP" && !(intent.attributive_label || "").trim()) {
    intent.attributive_label = name;
  }
  const query = buildOperationQuery(intent, {
    queryId: text(payload.id) || "preview",
    entityIds: ["preview-entity"],
  });
  return { query, name, description: text(payload.description), sequence: false };
}

async function applySchema(spaceId: string, payload: Record<string, unknown>): Promise<string> {
  const intent = schemaIntent(payload);
  if (!intent.attributive_label) throw new Error("attributive_label is required");
  const ids = await mintIds(mintedIdCount(intent));
  const query = buildOperationQuery(intent, ids);
  const ctx: AuthoringContext = { spaceId, query, runtimeEnabled: true };
  await assertPreflightClear(ctx);
  const saved = await saveQueryOperation(ctx, {
    name: intent.name,
    runtimeEnabled: true,
    addAsSequence: payload.add_as_sequence !== false,
    groupTitle: text(payload.group_title) || undefined,
    description: text(payload.description) || undefined,
  });
  if (payload.execute !== false) await runCreate(ctx);
  return saved.id;
}

async function applyOperation(spaceId: string, payload: Record<string, unknown>): Promise<string> {
  const name = text(payload.name);
  if (!name) throw new Error("name is required");
  const existingId = text(payload.id);
  const stored = existingId ? await loadPackage(existingId) : null;
  if (stored && stored.kind !== "sequence") {
    const base = (stored.builder_config as unknown as BuilderConfig | undefined)?.query;
    if (!text(payload.operation) || !text(payload.node_label)) {
      throw new Error("Updating an operation needs operation and node_label.");
    }
    const intent = operationIntent(payload, name);
    const query = buildOperationQuery(intent, {
      queryId: existingId,
      entityIds: base ? collectCreateEntityIds(base) : [],
    });
    query.id = existingId;
    query.name = name;
    const ctx: AuthoringContext = {
      spaceId,
      query,
      runtimeEnabled: payload.runtime_enabled !== false,
      matchPositions: (stored.builder_config as unknown as BuilderConfig | undefined)?.matchPositions,
    };
    const saved = await updateQueryOperation(ctx);
    if (payload.description !== undefined) {
      await connector.updateQueryDescription({
        spaceId,
        queryId: existingId,
        description: text(payload.description),
      });
    }
    return saved.id;
  }

  if (!text(payload.operation) || !text(payload.node_label)) {
    throw new Error("An operation needs operation and node_label.");
  }
  const intent = operationIntent(payload, name);
  if (intent.node_label === "STEP" && !(intent.attributive_label || "").trim()) {
    intent.attributive_label = name;
  }
  const ids = await mintIds(mintedIdCount(intent));
  const query = buildOperationQuery(intent, ids);
  const ctx: AuthoringContext = {
    spaceId,
    query,
    runtimeEnabled: payload.runtime_enabled !== false,
  };
  await assertPreflightClear(ctx);
  if (isStepCreateQuery(query)) {
    const single = isSingleNewStepCreate(query);
    if (payload.add_as_sequence === true && !single) {
      throw new Error(
        "add_as_sequence is only available for a single new STEP. Materialize the chain, then propose a sequence naming the entry STEP."
      );
    }
    if (single) {
      const published = await publishCreatedStepAsSequence(ctx, {
        name,
        groupTitle: text(payload.group_title) || undefined,
        description: text(payload.description) || undefined,
        addAsSequence: payload.add_as_sequence !== false,
      });
      return published.sequenceId || published.stepLabel;
    }
    await runCreate(ctx);
    return collectStepCreateAttributiveLabels(query)[0] || name;
  }
  const saved = await saveQueryOperation(ctx, {
    name,
    runtimeEnabled: ctx.runtimeEnabled,
    addAsSequence: payload.add_as_sequence !== false,
    groupTitle: text(payload.group_title) || undefined,
    description: text(payload.description) || undefined,
  });
  if (payload.execute === true) {
    if (query.operation !== "create") {
      throw new Error(`The operation was saved as ${saved.id}, but execute is only for create packages.`);
    }
    await runCreate(ctx);
  }
  return saved.id;
}

async function applyTransition(spaceId: string, payload: Record<string, unknown>): Promise<string> {
  const from = text(payload.from_step);
  const to = text(payload.to_step);
  if (!from || !to) throw new Error("from_step and to_step are required");
  const relationshipLabel = text(payload.relationship_label) || DEFAULT_STEP_RELATIONSHIP_LABEL;
  const [fromId, toId, queryId, relId] = await Promise.all([
    stepIdForLabel(spaceId, from),
    stepIdForLabel(spaceId, to),
    connector.generateQueryId(),
    connector.generateQueryId(),
  ]);
  const query = buildStepTransitionQuery(
    {
      from: { id: fromId, attributive_label: from },
      to: { id: toId, attributive_label: to },
      relationship_label: relationshipLabel,
      condition: text(payload.condition) || undefined,
      condition_type: (text(payload.condition_type) || "null") as ConditionType,
      condition_expected:
        typeof payload.condition_expected === "boolean" ? payload.condition_expected : undefined,
    },
    { queryId, entityIds: [relId] }
  );
  const ctx: AuthoringContext = { spaceId, query, runtimeEnabled: false };
  await assertPreflightClear(ctx);
  await runCreate(ctx);
  return relId;
}

async function applySequence(spaceId: string, payload: Record<string, unknown>): Promise<string> {
  const existingId = text(payload.id);
  const stored = existingId ? await loadPackage(existingId) : null;
  if (stored && (stored.kind === "sequence" || text(payload.kind) === "sequence")) {
    const storedConfig = stored.builder_config as unknown as BuilderConfig | undefined;
    const entry =
      text(payload.entry_step) || entryStepFrom(storedConfig?.query, stored.cypher);
    if (!entry) throw new Error("Pass entry_step. The saved sequence has no entry STEP.");
    if (text(payload.entry_step)) await stepIdForLabel(spaceId, entry);
    const requestedTraversal = text(payload.traversal).toLowerCase();
    const traversal =
      requestedTraversal === "single" || requestedTraversal === "downstream"
        ? requestedTraversal
        : storedConfig?.query?.read_traversal === "downstream"
          ? "downstream"
          : "single";
    const query = text(payload.entry_step) || text(payload.traversal)
      ? buildSequenceQuery({ id: existingId, entry_step: entry, traversal })
      : storedConfig?.query
        ? { ...storedConfig.query, id: existingId }
        : buildSequenceQuery({ id: existingId, entry_step: entry, traversal });
    query.id = existingId;
    const parameterValues =
      payload.parameters !== undefined
        ? await assertSequenceBindings(spaceId, bindingsFrom(payload.parameters), {
            sequenceId: text(payload.entry_step) ? undefined : existingId,
            entryStep: entry,
            traversal,
          })
        : parseSequenceParameterValues(stored.parameters);
    const ctx: AuthoringContext = {
      spaceId,
      query,
      runtimeEnabled: true,
      matchPositions: storedConfig?.matchPositions,
    };
    const saved = await updateSequencePackage(ctx, {
      id: existingId,
      name: text(payload.name) || stored.name,
      groupTitle: text(payload.group_title) || stored.group_title || "",
      description: payload.description === undefined ? stored.description : text(payload.description),
      loop: buildLoopConfig(loopIntent(payload.loop ?? stored.loop_config)),
      parameterValues,
    });
    return saved.id;
  }

  const entry = text(payload.entry_step);
  const name = text(payload.name);
  if (!entry) throw new Error("entry_step is required");
  if (!name) throw new Error("name is required");
  await stepIdForLabel(spaceId, entry);
  const traversal = text(payload.traversal).toLowerCase() === "single" ? "single" : "downstream";
  const parameterValues = await assertSequenceBindings(spaceId, bindingsFrom(payload.parameters), {
    entryStep: entry,
    traversal,
  });
  const sequenceId = existingId || (await connector.generateQueryId());
  const query = buildSequenceQuery({ id: sequenceId, entry_step: entry, traversal });
  const ctx: AuthoringContext = { spaceId, query, runtimeEnabled: true };
  const saved = await saveSequencePackage(ctx, {
    id: sequenceId,
    name,
    groupTitle: text(payload.group_title),
    description: text(payload.description) || undefined,
    loop: buildLoopConfig(loopIntent(payload.loop)),
    parameterValues,
  });
  return saved.id;
}

async function applyOne(spaceId: string, item: ChatIntentItem): Promise<string> {
  const payload = payloadOf(item);
  if (item.kind === "upsert_schema") return applySchema(spaceId, payload);
  if (item.kind === "create_transition") return applyTransition(spaceId, payload);
  if (item.kind === "upsert_query") {
    if (text(payload.kind).toLowerCase() === "sequence") return applySequence(spaceId, payload);
    return applyOperation(spaceId, payload);
  }
  throw new Error(`Not a builder change: ${item.kind}`);
}

/** Save builder items in schema, operation, transition, sequence order. Stops at the first failure. */
export async function applyChatIntents(spaceId: string, items: ChatIntentItem[]): Promise<ChatIntentResult> {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item) - rank(right.item) || left.index - right.index)
    .map((entry) => entry.item);
  const applied: ChatIntentApplied[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    try {
      const id = await applyOne(spaceId, item);
      applied.push({ kind: item.kind, summary: summaryOf(item), id: id || null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        applied,
        failed: { kind: item.kind, summary: summaryOf(item), error: message.slice(0, 500) },
        not_applied: ordered.slice(index + 1).map((pending) => ({
          kind: pending.kind,
          summary: summaryOf(pending),
        })),
      };
    }
  }
  return { ok: true, applied, failed: null, not_applied: [] };
}
