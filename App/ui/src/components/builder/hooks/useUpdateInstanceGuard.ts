import { useEffect, useMemo } from "react";
import composer from "../../../services/composer";
import connector from "../../../services/connector";
import { cypherStatementsForExecution, runReadCypher } from "../../../services/execute";
import { useBuilder } from "../../../state/builder/BuilderContext";
import { isAttributiveLabelParameter } from "../../../state/builder/normalizeField";
import { queryUsesParameters } from "../../../state/builder/parameterRefs";
import { collectReadMatchPathBindings } from "../../../state/builder/returnProjections";
import { normalizeForCompose } from "../../../state/builder/selectors";
import {
  buildMatchReadQuery,
  schemaConstraintMap,
  setCoveredRequiredKeys,
  summarizeGuardIssues,
  UPDATE_GUARD_CHECK_KEY,
  UPDATE_GUARD_INFO_KEY,
  validateMatchedInstances,
  validateSetItems,
  validateWhereValues,
  type ConstraintsByLabel,
  type GuardIssue
} from "../../../state/builder/updateInstanceGuard";

const GUARD_DEBOUNCE_MS = 400;

/**
 * Debounced schema guard for update INSTANCE. On every MATCH/WHERE/SET change it
 * fetches the bound schema definitions, statically validates SET and WHERE values,
 * and (for non-parameterized queries) runs the MATCH as a read query to verify the
 * referenced instances satisfy the schema. Any violation registers a failing
 * `uguard` check, which `checksAllClear` uses to block Run. Blast-radius notes go to
 * the display-only `uguardInfo` check.
 */
export function useUpdateInstanceGuard(): void {
  const { state, dispatch } = useBuilder();
  const { query, spaceId } = state;

  const enabled =
    query.operation === "update" && query.match[0]?.label === "INSTANCE" && Boolean(spaceId);

  // Re-run whenever any input that affects targeting, assignment, or parameterization changes.
  const signature = useMemo(
    () => JSON.stringify({ match: query.match, set: query.set ?? [], parameters: query.parameters }),
    [query.match, query.set, query.parameters]
  );

  useEffect(() => {
    if (!enabled || !spaceId) {
      dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_CHECK_KEY, check: { status: "idle" } });
      dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_INFO_KEY, check: { status: "idle" } });
      return;
    }

    let cancelled = false;
    dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_CHECK_KEY, check: { status: "checking" } });
    dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_INFO_KEY, check: { status: "idle" } });

    const timer = window.setTimeout(() => {
      runGuard()
        .then(({ check, info }) => {
          if (cancelled) return;
          dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_CHECK_KEY, check });
          dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_INFO_KEY, check: info });
        })
        .catch(() => {
          // Transient failure (schema fetch / read query): don't block Run on it.
          if (cancelled) return;
          dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_CHECK_KEY, check: { status: "ok" } });
          dispatch({ type: "SET_CHECK", key: UPDATE_GUARD_INFO_KEY, check: { status: "idle" } });
        });
    }, GUARD_DEBOUNCE_MS);

    async function runGuard() {
      const bindings = collectReadMatchPathBindings(query);
      const labels = Array.from(
        new Set(
          bindings
            .map((b) => b.attributive_label)
            .filter((label) => Boolean(label) && !isAttributiveLabelParameter(label))
        )
      );

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

      const issues: GuardIssue[] = [
        ...validateSetItems(query.set ?? [], bindings, constraintsByLabel),
        ...validateWhereValues(query, constraintsByLabel)
      ];

      let info = "";
      // A parameterized query has no resolvable literals (and no Run button), so the
      // live read is skipped; only the static SET/WHERE checks above apply.
      if (!queryUsesParameters(query) && bindings.length > 0) {
        const cypher = cypherStatementsForExecution(
          composer.composeQuery(normalizeForCompose(buildMatchReadQuery(query, bindings))).cypher
        );
        const result = await runReadCypher(spaceId ?? "", cypher);
        // Properties the SET clause is about to fill shouldn't count as missing-required
        // drift — the update itself resolves them.
        const coveredRequiredKeys = setCoveredRequiredKeys(query.set ?? [], bindings);
        const matched = validateMatchedInstances(result, constraintsByLabel, coveredRequiredKeys);
        issues.push(...matched.issues);
        if (matched.count === 0) {
          info = "No instances match these filters — this UPDATE would affect nothing.";
        }
      }

      const check =
        issues.length > 0
          ? { status: "error" as const, message: summarizeGuardIssues(issues) }
          : { status: "ok" as const, message: "schema constraints satisfied" };
      return {
        check,
        info: info ? { status: "ok" as const, message: info } : { status: "idle" as const }
      };
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, spaceId, dispatch]);
}
