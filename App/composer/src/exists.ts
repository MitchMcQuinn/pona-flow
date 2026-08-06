/** EXISTS { MATCH (i:INSTANCE) WHERE … } subquery builder. */

import { EXISTS_INSTANCE_VAR } from "./constants.js";
import { cypherNodePropertyRef } from "./cypher-keys.js";
import { formatExistsRhs } from "./literals.js";
import type { CypherConditionBuilder } from "./types.js";

export function buildExistsInstanceCondition(builder: CypherConditionBuilder | null | undefined): string {
  const predicates = (builder && builder.predicates) || [];
  const combine = builder && builder.combine === "OR" ? "OR" : "AND";
  const parts = predicates
    .map((p) => {
      if (!p || !p.property) return "";
      const prop = String(p.property).trim();
      const op = p.operator || "=";
      const lhs = cypherNodePropertyRef(EXISTS_INSTANCE_VAR, prop);
      if (op === "IS NULL" || op === "IS NOT NULL") {
        return `${lhs} ${op}`;
      }
      let rhs = "";
      if (p.parameter) {
        rhs = `$${p.parameter}`;
      } else if (p.value !== undefined && p.value !== null && p.value !== "") {
        rhs = formatExistsRhs(p.value);
      } else {
        return "";
      }
      return `${lhs} ${op} ${rhs}`;
    })
    .filter(Boolean);
  if (!parts.length) return "";
  const where = parts.join(combine === "OR" ? " OR " : " AND ");
  return `EXISTS { MATCH (${EXISTS_INSTANCE_VAR}:INSTANCE) WHERE ${where} }`;
}
