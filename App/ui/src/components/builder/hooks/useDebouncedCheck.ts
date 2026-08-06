import { useEffect } from "react";
import { useBuilder } from "../../../state/builder/BuilderContext";
import type { FieldCheck } from "../../../state/builder/types";

// Generic debounced async validation: registers a FieldCheck under `key` and
// re-runs `run` whenever `signature` changes. Disabled checks are cleared.
export function useDebouncedCheck(
  key: string,
  enabled: boolean,
  signature: string,
  run: () => Promise<FieldCheck>,
  delay = 400
): void {
  const { dispatch } = useBuilder();

  useEffect(() => {
    if (!enabled) {
      dispatch({ type: "SET_CHECK", key, check: { status: "idle" } });
      return;
    }
    let cancelled = false;
    dispatch({ type: "SET_CHECK", key, check: { status: "checking" } });
    const timer = window.setTimeout(() => {
      run()
        .then((result) => {
          if (!cancelled) dispatch({ type: "SET_CHECK", key, check: result });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            dispatch({
              type: "SET_CHECK",
              key,
              check: {
                status: "error",
                message: error instanceof Error ? error.message : "check failed"
              }
            });
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, signature, dispatch]);
}
