import { useEffect, useMemo } from "react";
import connector from "../../../services/connector";
import type { SchemaPropertyConstraint } from "../../../services/connector";
import { useBuilder } from "../../../state/builder/BuilderContext";
import {
  createInstanceNodeLabels,
  createInstancePrecedingLabels,
  reconcileCreateInstanceQuery,
  relSchemaKey
} from "../../../state/builder/createInstanceSync";

const SYNC_DEBOUNCE_MS = 300;

/**
 * Keep an open create-INSTANCE operation's adopted properties in sync with the live schema.
 * On every MATCH change it fetches the bound SCHEMA definitions (for nodes) and outgoing edges
 * (for relationships), then rewrites each new INSTANCE entity's properties: newly added schema
 * properties appear as editable rows, deleted ones are stripped, and parameters orphaned by a
 * deletion are pruned. The pass is idempotent — once the snapshot matches the schema it makes no
 * further edits — so it settles after healing drift without fighting ongoing edits.
 */
export function useCreateInstanceSchemaSync(): void {
  const { state, patchQuery } = useBuilder();
  const { query, spaceId } = state;

  const enabled =
    query.operation === "create" && query.match[0]?.label === "INSTANCE" && Boolean(spaceId);

  const signature = useMemo(() => JSON.stringify(query.match), [query.match]);

  useEffect(() => {
    if (!enabled || !spaceId) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void runSync();
    }, SYNC_DEBOUNCE_MS);

    async function runSync() {
      const nodeLabels = createInstanceNodeLabels(query);
      const precedingLabels = createInstancePrecedingLabels(query);
      if (!nodeLabels.length && !precedingLabels.length) return;

      const nodeSchemata = new Map<string, SchemaPropertyConstraint[]>();
      const relSchemata = new Map<string, SchemaPropertyConstraint[]>();

      await Promise.all([
        ...nodeLabels.map(async (label) => {
          try {
            const def = await connector.fetchSchemaDefinition({
              spaceId: spaceId ?? "",
              attributiveLabel: label
            });
            nodeSchemata.set(label, def.schemata ?? []);
          } catch {
            // Unknown schema: leave it out so the entity is skipped (no spurious edits).
          }
        }),
        ...precedingLabels.map(async (label) => {
          try {
            const edges = await connector.fetchSchemaOutgoing({
              spaceId: spaceId ?? "",
              attributiveLabel: label
            });
            for (const edge of edges) {
              relSchemata.set(relSchemaKey(label, edge.rel_attributive_label), edge.rel_schemata);
            }
          } catch {
            // Unknown outgoing edges: leave out so relationships are skipped.
          }
        })
      ]);

      if (cancelled) return;
      const next = reconcileCreateInstanceQuery(query, nodeSchemata, relSchemata);
      if (!cancelled && next) patchQuery(() => next);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, spaceId]);
}
