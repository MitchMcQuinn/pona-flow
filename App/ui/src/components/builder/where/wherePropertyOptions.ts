import connector from "../../../services/connector";
import type { GraphNodeLabel } from "../../../state/builder/types";

function graphEntityLabel(
  clauseLabel: GraphNodeLabel,
  entityRole: "node" | "relationship"
): string {
  if (entityRole === "relationship") return "POINTS_TO";
  return clauseLabel;
}

async function schemaPropertyKeysFromCatalog(
  spaceId: string,
  schemaAttributiveLabel: string
): Promise<string[]> {
  try {
    const def = await connector.fetchSchemaDefinition({
      spaceId,
      attributiveLabel: schemaAttributiveLabel
    });
    return (def.schemata ?? []).map((s) => s.key).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Property keys for WHERE filters on this path entry.
 *
 * Read INSTANCE: keys from SCHEMA ``entities`` payload (via property-keys API);
 * values are loaded separately from graph INSTANCE entities. The list includes the
 * engine-minted ``id`` key so RUD WHERE filters (and RETURN/ORDER BY) can target the
 * automatic instance ID; SET pickers pass ``omitInstanceAutoId`` because that id is
 * minted by the engine and must never be reassigned.
 */
export async function fetchWherePropertyKeysForEntity(opts: {
  spaceId: string;
  matchClauseLabel: GraphNodeLabel;
  entityRole: "node" | "relationship";
  attributiveLabel: string;
  omitInstanceAutoId?: boolean;
}): Promise<string[]> {
  const al = (opts.attributiveLabel || "").trim();
  if (!al || !opts.spaceId) return [];

  if (opts.matchClauseLabel === "INSTANCE") {
    try {
      const keys = await connector.fetchGraphPropertyKeys({
        spaceId: opts.spaceId,
        entityLabel: "INSTANCE",
        attributiveLabel: al,
        entityRole: opts.entityRole
      });
      // "id" is reserved at SCHEMA create, so a key literally named "id" is always
      // the automatic instance ID (never an author-defined property).
      const filtered = opts.omitInstanceAutoId ? keys.filter((k) => k !== "id") : keys;
      return filtered.sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  const schemaKeys =
    opts.matchClauseLabel === "SCHEMA"
      ? await schemaPropertyKeysFromCatalog(opts.spaceId, al)
      : [];

  let graphKeys: string[] = [];
  try {
    graphKeys = await connector.fetchGraphPropertyKeys({
      spaceId: opts.spaceId,
      entityLabel: graphEntityLabel(opts.matchClauseLabel, opts.entityRole),
      attributiveLabel: al,
      entityRole: opts.entityRole
    });
  } catch {
    graphKeys = [];
  }

  // SCHEMA nodes only carry their own real properties (e.g. attributive_label); the
  // declared schemata describe INSTANCE properties and are NOT stored on the SCHEMA node.
  // Union the declared keys with the actual graph keys so the picker surfaces both the
  // schema's defined properties and the node's real, filterable properties (intersecting
  // them yields an empty list because the two sets are disjoint for SCHEMA).
  const merged = new Set<string>([...schemaKeys, ...graphKeys]);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

/** Distinct property values on graph entities for INSTANCE read WHERE value pickers. */
export async function fetchWherePropertyValuesForEntity(opts: {
  spaceId: string;
  matchClauseLabel: GraphNodeLabel;
  entityRole: "node" | "relationship";
  attributiveLabel: string;
  propertyKey: string;
}): Promise<string[]> {
  const al = (opts.attributiveLabel || "").trim();
  const key = (opts.propertyKey || "").trim();
  if (!al || !key || !opts.spaceId) return [];

  const entityLabel =
    opts.matchClauseLabel === "INSTANCE"
      ? "INSTANCE"
      : graphEntityLabel(opts.matchClauseLabel, opts.entityRole);

  try {
    return await connector.fetchGraphPropertyValues({
      spaceId: opts.spaceId,
      entityLabel,
      attributiveLabel: al,
      propertyKey: key,
      entityRole: opts.entityRole
    });
  } catch {
    return [];
  }
}
