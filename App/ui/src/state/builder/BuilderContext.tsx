import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from "react";
import { builderReducer } from "./reducer";
import { initialBuilderState } from "./defaults";
import type { BuilderAction } from "./actions";
import type { BuilderState, QueryObject } from "./types";

interface BuilderContextValue {
  state: BuilderState;
  dispatch: React.Dispatch<BuilderAction>;
  /** True while the builder is authoring a navigation sequence (create-sequence mode). */
  createSequenceMode: boolean;
  /**
   * The caller's effective flow keys (`"<op>:<element>"`) in this space, or null when
   * permissions are unknown/unrestricted. Drives operation/label gating in the builder.
   */
  flows: string[] | null;
  // Ergonomic immutable edit of the query tree.
  patchQuery: (updater: (query: QueryObject) => QueryObject) => void;
}

const BuilderContext = createContext<BuilderContextValue | null>(null);

export function BuilderProvider({
  spaceId,
  createSequenceMode = false,
  flows = null,
  children
}: {
  spaceId: string | null;
  createSequenceMode?: boolean;
  flows?: string[] | null;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(builderReducer, spaceId, initialBuilderState);

  const patchQuery = useCallback(
    (updater: (query: QueryObject) => QueryObject) => {
      dispatch({ type: "UPDATE_QUERY", updater });
    },
    [dispatch]
  );

  const value = useMemo<BuilderContextValue>(
    () => ({ state, dispatch, createSequenceMode, flows, patchQuery }),
    [state, createSequenceMode, flows, patchQuery]
  );

  return <BuilderContext.Provider value={value}>{children}</BuilderContext.Provider>;
}

/** Whether the effective flows permit `<operation>:<element>` (null flows = unrestricted). */
export function flowAllowed(
  flows: string[] | null,
  operation: string,
  element: string
): boolean {
  if (flows === null) return true;
  return flows.includes(`${operation}:${element}`);
}

/** Whether any element permits the given operation (used to gate operation buttons). */
export function operationAllowed(flows: string[] | null, operation: string): boolean {
  if (flows === null) return true;
  return flows.some((f) => f.startsWith(`${operation}:`));
}

export function useBuilder(): BuilderContextValue {
  const ctx = useContext(BuilderContext);
  if (!ctx) {
    throw new Error("useBuilder must be used within a BuilderProvider");
  }
  return ctx;
}
