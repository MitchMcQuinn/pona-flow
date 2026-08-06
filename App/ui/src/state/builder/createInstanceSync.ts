// Reconcile an open create-INSTANCE operation against the live schema. A saved create-INSTANCE
// operation freezes the property list it was built against, so when the SCHEMA later changes
// (add/delete-only) the snapshot drifts. On open we re-read the live schema and rewrite each new
// INSTANCE node/relationship's adopted properties so the editor reflects the current schema:
//   - added property   -> appended as an editable row (default value if any; UID rows autofill)
//   - deleted property -> its row is stripped, and any parameter it solely fed is pruned
//   - retained property -> kept as-is (existing value / parameter binding preserved)
// Side effects (schema fetches) live in the useCreateInstanceSchemaSync hook; these helpers are
// pure so the merge logic stays unit-testable.
import { isAttributiveLabelParameter } from "./normalizeField";
import { extractExactParameterRef } from "./parameterRefs";
import { propertiesFromSchemata } from "./schemaRules";
import type { SchemaPropertyConstraint } from "../../services/connector";
import type {
  Parameter,
  PropertyBinding,
  QueryObject,
  RelationshipPattern
} from "./types";

/** NUL-joined `precedingNodeLabel + relLabel` key for relationship-edge schema lookups. */
export function relSchemaKey(precedingLabel: string, relLabel: string): string {
  return `${precedingLabel}\u0000${relLabel}`;
}

/** A new INSTANCE node/relationship is one we author values for (not a reference, has rows). */
function isAdoptedEntity(entity: {
  alias_mode?: string;
  node_source?: string;
  properties?: PropertyBinding[];
}): boolean {
  if (entity.alias_mode === "reference") return false;
  if (entity.node_source !== "new") return false;
  // An unresolved target has no rows yet; only reconcile entities the author already populated.
  return Boolean(entity.properties && entity.properties.length > 0);
}

/** Distinct attributive_labels of adopted INSTANCE nodes (need a SCHEMA definition fetch). */
export function createInstanceNodeLabels(query: QueryObject): string[] {
  const labels = new Set<string>();
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        if (el.kind !== "node" || !isAdoptedEntity(el.node)) continue;
        const al = (el.node.attributive_label || "").trim();
        if (al && !isAttributiveLabelParameter(al)) labels.add(al);
      }
    }
  }
  return [...labels];
}

/** Distinct preceding-node labels for adopted INSTANCE relationships (need an outgoing-edge fetch). */
export function createInstancePrecedingLabels(query: QueryObject): string[] {
  const labels = new Set<string>();
  for (const clause of query.match || []) {
    if (clause.label !== "INSTANCE") continue;
    for (const pattern of clause.patterns || []) {
      const path = pattern.path || [];
      path.forEach((el, i) => {
        if (el.kind !== "relationship" || !isAdoptedEntity(el.relationship)) return;
        const preceding = path[i - 1];
        const precedingLabel =
          preceding && preceding.kind === "node"
            ? (preceding.node.attributive_label || "").trim()
            : "";
        if (precedingLabel && !isAttributiveLabelParameter(precedingLabel)) labels.add(precedingLabel);
      });
    }
  }
  return [...labels];
}

interface EntityReconcileResult {
  properties: PropertyBinding[];
  droppedParamRefs: string[];
  changed: boolean;
}

/** Drop the parameter ref a binding feeds (exact `$param` value or explicit `parameter`). */
function paramRefOf(binding: PropertyBinding): string | null {
  if (binding.parameter && binding.parameter.trim()) return binding.parameter.trim();
  return extractExactParameterRef(String(binding.value ?? "").trim());
}

/** Reconcile one entity's adopted properties against the live constraints. */
function reconcileEntityProperties(
  existing: PropertyBinding[],
  constraints: SchemaPropertyConstraint[]
): EntityReconcileResult {
  const live = propertiesFromSchemata(constraints);
  const liveKeys = new Set(live.map((p) => (p.key || "").trim()));
  const existingKeys = new Set(existing.map((p) => (p.key || "").trim()));

  const retained: PropertyBinding[] = [];
  const droppedParamRefs: string[] = [];
  let changed = false;
  for (const prop of existing) {
    if (liveKeys.has((prop.key || "").trim())) {
      retained.push(prop);
    } else {
      changed = true;
      const ref = paramRefOf(prop);
      if (ref) droppedParamRefs.push(ref);
    }
  }

  const appended = live.filter(
    (p) => !p.schematic_properties?.is_key && !existingKeys.has((p.key || "").trim())
  );
  if (appended.length) changed = true;

  return { properties: [...retained, ...appended], droppedParamRefs, changed };
}

/** Every parameter name still referenced by any INSTANCE node/relationship in the query. */
function referencedParameterNames(query: QueryObject): Set<string> {
  const refs = new Set<string>();
  const add = (value: unknown) => {
    const ref = extractExactParameterRef(String(value ?? "").trim());
    if (ref) refs.add(ref);
  };
  for (const clause of query.match || []) {
    for (const pattern of clause.patterns || []) {
      for (const el of pattern.path || []) {
        const entity = el.kind === "node" ? el.node : el.relationship;
        if (!entity) continue;
        add(entity.attributive_label);
        add(entity.id_binding?.value);
        for (const prop of entity.properties || []) {
          add(prop.value);
          if (prop.parameter && prop.parameter.trim()) refs.add(prop.parameter.trim());
        }
      }
    }
  }
  return refs;
}

/**
 * Reconcile every adopted INSTANCE node/relationship against the live schema. Returns a new
 * QueryObject when anything changed (so the caller can patch), or null when already in sync.
 *
 * - ``nodeSchemata`` maps an INSTANCE node attributive_label -> its schema constraints.
 * - ``relSchemata`` maps {@link relSchemaKey}(precedingLabel, relLabel) -> the edge's constraints.
 */
export function reconcileCreateInstanceQuery(
  query: QueryObject,
  nodeSchemata: Map<string, SchemaPropertyConstraint[]>,
  relSchemata: Map<string, SchemaPropertyConstraint[]>
): QueryObject | null {
  let changed = false;
  const droppedParamRefs = new Set<string>();

  const match = (query.match || []).map((clause) => {
    if (clause.label !== "INSTANCE") return clause;
    return {
      ...clause,
      patterns: (clause.patterns || []).map((pattern) => {
        const path = pattern.path || [];
        return {
          ...pattern,
          path: path.map((el, i) => {
            if (el.kind === "node") {
              if (!isAdoptedEntity(el.node)) return el;
              const al = (el.node.attributive_label || "").trim();
              const constraints = nodeSchemata.get(al);
              if (!constraints) return el;
              const res = reconcileEntityProperties(el.node.properties, constraints);
              if (!res.changed) return el;
              changed = true;
              res.droppedParamRefs.forEach((r) => droppedParamRefs.add(r));
              return { ...el, node: { ...el.node, properties: res.properties } };
            }
            if (!isAdoptedEntity(el.relationship)) return el;
            const preceding = path[i - 1];
            const precedingLabel =
              preceding && preceding.kind === "node"
                ? (preceding.node.attributive_label || "").trim()
                : "";
            const relLabel = (el.relationship.attributive_label || "").trim();
            const constraints = relSchemata.get(relSchemaKey(precedingLabel, relLabel));
            if (!constraints) return el;
            const res = reconcileEntityProperties(el.relationship.properties, constraints);
            if (!res.changed) return el;
            changed = true;
            res.droppedParamRefs.forEach((r) => droppedParamRefs.add(r));
            return {
              ...el,
              relationship: { ...el.relationship, properties: res.properties } as RelationshipPattern
            };
          })
        };
      })
    };
  });

  if (!changed) return null;

  // Prune only parameters that a now-deleted property solely fed and nothing else references.
  let parameters: Parameter[] = query.parameters || [];
  if (droppedParamRefs.size) {
    const stillReferenced = referencedParameterNames({ ...query, match });
    const orphaned = [...droppedParamRefs].filter((name) => !stillReferenced.has(name));
    if (orphaned.length) {
      const orphanSet = new Set(orphaned);
      parameters = parameters.filter((p) => !orphanSet.has(String(p.name ?? "").trim()));
    }
  }

  return { ...query, match, parameters };
}
