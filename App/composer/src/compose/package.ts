/** Compose all queries in a package into one preview string plus per-query metadata. */

import { composeQuery } from "./query.js";
import type { QueryObject } from "../types.js";

export function composePackage(packageObj: { queries?: QueryObject[] } | null | undefined) {
  const queries = (packageObj && packageObj.queries) || [];
  const blocks = queries.map((q) => {
    const { cypher, parameters, operation } = composeQuery(q);
    return {
      id: q.id || "",
      name: q.name || "",
      operation: operation || q.operation || "read",
      cypher,
      parameters,
    };
  });

  const cypher = blocks
    .map((b) => {
      const header = `// --- ${b.id || "query"}${b.name ? `: ${b.name}` : ""} (${b.operation}) ---`;
      const paramLine =
        Object.keys(b.parameters).length > 0
          ? `// parameters: ${JSON.stringify(b.parameters)}`
          : "// parameters: {}";
      return `${header}\n${paramLine}\n${b.cypher || "(empty query)"}`;
    })
    .join("\n\n");

  return { cypher, parametersByQuery: blocks };
}
