import type { Dispatch } from "react";
import type { BuilderAction } from "./actions";

/** After a new catalog operation is saved, assign a fresh query id for the next create. */
export function regenerateQueryIdAfterOperationSave(dispatch: Dispatch<BuilderAction>): void {
  dispatch({ type: "REGENERATE_QUERY_ID" });
}
