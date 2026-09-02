// Archived from App/authoring/src/operations.ts
/**
 * Persist code-execution STEP scripts to the resources API before composing, so the
 * entity payload references a saved resource UID (the code never enters the payload).
 *
 * The resource id is stable per STEP node (existing resource_id, else the node's
 * entity id), which makes retries idempotent — a failed run that already saved the
 * resource updates it in place on the next attempt instead of creating a duplicate.
 * Returns a context copy with resource_ids filled in for the composer.
 */
export async function persistCodeResources<T extends AuthoringContext>(ctx: T): Promise<T> {
  const spaceId = ctx.spaceId ?? "";
  const query = ctx.query;
  if (!spaceId) return ctx;
  const editable =
    query.operation === "create"
      ? (node: { node_source?: string; alias_mode?: string }) =>
          node.node_source === "new" && node.alias_mode !== "reference"
      : query.operation === "update"
        ? () => true
        : () => false;

  let changed = false;
  const match = [];
  for (const clause of query.match) {
    if (clause.label !== "STEP") {
      match.push(clause);
      continue;
    }
    const patterns = [];
    for (const pattern of clause.patterns) {
      const path = [];
      for (const el of pattern.path) {
        if (el.kind !== "node") {
          path.push(el);
          continue;
        }
        const sp = el.node.sequencial_properties;
        if (!sp || sp.query_id || sp.step_type !== "code" || !editable(el.node)) {
          path.push(el);
          continue;
        }
        const name = (sp.resource_name ?? "").trim();
        const code = sp.code ?? "";
        if (!name || !code.trim()) {
          throw new Error("A code STEP node requires a name and code before running.");
        }
        const stableId =
          (sp.resource_id ?? "").trim() ||
          String(el.node.id_binding?.value ?? "").trim() ||
          undefined;
        const saved = await connector.upsertCodeResource(spaceId, {
          resourceId: stableId,
          name,
          description: sp.resource_description ?? "",
          language: sp.language === "javascript" ? "javascript" : "python",
          code
        });
        changed = true;
        path.push({
          ...el,
          node: {
            ...el.node,
            sequencial_properties: { ...sp, resource_id: saved.id }
          }
        });
      }
      patterns.push({ ...pattern, path });
    }
    match.push({ ...clause, patterns });
  }
  if (!changed) return ctx;
  return { ...ctx, query: { ...query, match } };
}

