/**
 * SCHEMA / STEP delete-cascade endpoints.
 *
 * Both flows are two-phase by design: `preview*` resolves the blast radius across the
 * graph, the entities mirror, catalog queries, and stored execution packages without
 * writing anything; `execute*` re-runs the resolution and commits, and the server
 * rejects it unless `confirm` is true.
 */

import { requestJson } from "./http.js";
import type {
  OperationDeletePreview,
  OperationDeleteResult,
  SchemaDeletePreview,
  SchemaDeleteResult,
  StepDeletePreview,
  StepDeleteResult,
} from "./types.js";

/** Dry-run the SCHEMA delete cascade: returns the blast radius and warnings (no writes). */
export async function previewSchemaDeletion(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<SchemaDeletePreview> {
  return requestJson<SchemaDeletePreview>("/api/schema/delete/preview", {
    method: "POST",
    body: { space_id: opts.spaceId, attributive_label: opts.attributiveLabel },
    apiBase,
    errorLabel: "previewing schema deletion",
  });
}

/** Execute the SCHEMA delete cascade after the caller confirms the preview. */
export async function executeSchemaDeletion(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<SchemaDeleteResult> {
  return requestJson<SchemaDeleteResult>("/api/schema/delete", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      attributive_label: opts.attributiveLabel,
      confirm: true,
    },
    apiBase,
    errorLabel: "deleting schema",
  });
}

/** Dry-run the STEP delete cascade: returns the blast radius and warnings (no writes). */
export async function previewStepDeletion(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<StepDeletePreview> {
  return requestJson<StepDeletePreview>("/api/step/delete/preview", {
    method: "POST",
    body: { space_id: opts.spaceId, attributive_label: opts.attributiveLabel },
    apiBase,
    errorLabel: "previewing step deletion",
  });
}

/** Execute the STEP delete cascade after the caller confirms the preview. */
export async function executeStepDeletion(
  opts: { spaceId: string; attributiveLabel: string },
  apiBase?: string
): Promise<StepDeleteResult> {
  return requestJson<StepDeleteResult>("/api/step/delete", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      attributive_label: opts.attributiveLabel,
      confirm: true,
    },
    apiBase,
    errorLabel: "deleting step",
  });
}

/** Dry-run deleting an operation + one-step wrap (suspends multi-step dependents). */
export async function previewOperationDeletion(
  opts: { spaceId: string; operationId?: string; sequenceId?: string },
  apiBase?: string
): Promise<OperationDeletePreview> {
  return requestJson<OperationDeletePreview>("/api/operation/delete/preview", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      operation_id: opts.operationId || "",
      sequence_id: opts.sequenceId || "",
    },
    apiBase,
    errorLabel: "previewing operation deletion",
  });
}

/** Delete an operation, its wrap STEP, and one-step sequences; suspend multi-step dependents. */
export async function executeOperationDeletion(
  opts: { spaceId: string; operationId?: string; sequenceId?: string },
  apiBase?: string
): Promise<OperationDeleteResult> {
  return requestJson<OperationDeleteResult>("/api/operation/delete", {
    method: "POST",
    body: {
      space_id: opts.spaceId,
      operation_id: opts.operationId || "",
      sequence_id: opts.sequenceId || "",
      confirm: true,
    },
    apiBase,
    errorLabel: "deleting operation",
  });
}
