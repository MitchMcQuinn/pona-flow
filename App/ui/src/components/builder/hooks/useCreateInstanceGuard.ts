import { useEffect, useMemo } from "react";
import connector from "../../../services/connector";
import { useBuilder } from "../../../state/builder/BuilderContext";
import {
  CREATE_GUARD_CHECK_KEY,
  createInstanceLabels,
  summarizeCreateGuardIssues,
  validateCreateInstances
} from "../../../state/builder/createInstanceGuard";
import { schemaConstraintMap, type ConstraintsByLabel } from "../../../state/builder/updateInstanceGuard";

const GUARD_DEBOUNCE_MS = 400;

/**
 * Debounced schema guard for create INSTANCE. On every MATCH/parameter change it fetches the
 * bound schema definitions and statically validates the operation's adopted properties against
 * the live schema, catching drift left behind when the SCHEMA changed after the operation was
 * saved. A violation registers a failing `cguard` check, which `checksAllClear` uses to block
 * Run until the operation is reconciled.
 */
export function useCreateInstanceGuard(): void {
  const { state, dispatch } = useBuilder();
  const { query, spaceId } = state;

  const enabled =
    query.operation === "create" && query.match[0]?.label === "INSTANCE" && Boolean(spaceId);

  const signature = useMemo(
    () => JSON.stringify({ match: query.match, parameters: query.parameters }),
    [query.match, query.parameters]
  );

  useEffect(() => {
    if (!enabled || !spaceId) {
      dispatch({ type: "SET_CHECK", key: CREATE_GUARD_CHECK_KEY, check: { status: "idle" } });
      return;
    }

    let cancelled = false;
    dispatch({ type: "SET_CHECK", key: CREATE_GUARD_CHECK_KEY, check: { status: "checking" } });

    const timer = window.setTimeout(() => {
      runGuard()
        .then((check) => {
          if (!cancelled) dispatch({ type: "SET_CHECK", key: CREATE_GUARD_CHECK_KEY, check });
        })
        .catch(() => {
          // Transient failure (schema fetch): don't block Run on it.
          if (!cancelled)
            dispatch({ type: "SET_CHECK", key: CREATE_GUARD_CHECK_KEY, check: { status: "ok" } });
        });
    }, GUARD_DEBOUNCE_MS);

    async function runGuard() {
      const labels = createInstanceLabels(query);
      const constraintsByLabel: ConstraintsByLabel = new Map();
      await Promise.all(
        labels.map(async (label) => {
          try {
            const def = await connector.fetchSchemaDefinition({
              spaceId: spaceId ?? "",
              attributiveLabel: label
            });
            constraintsByLabel.set(label, schemaConstraintMap(def));
          } catch {
            // Unknown schema: treated as "no constraints" (no static issues raised).
          }
        })
      );
      const issues = validateCreateInstances(query, constraintsByLabel);
      return issues.length > 0
        ? { status: "error" as const, message: summarizeCreateGuardIssues(issues) }
        : { status: "ok" as const, message: "schema constraints satisfied" };
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, spaceId, dispatch]);
}
