import type { GraphPayload, GraphRelationship } from '../../state/builder/types'
import { isRecord } from './data'

/**
 * Console graph data, normalized to the payload GraphView already draws.
 *
 * Accepts a sequence final result (`{ kind: "graph", graph }`), that graph
 * object directly, or a short form with `id` / `label` nodes and
 * `source` / `target` relationships (`edges` is accepted as an alias).
 */
export function graphPayloadFromModuleData(data: unknown): GraphPayload | null {
  const source = graphRecord(data)
  if (!source || !Array.isArray(source.nodes)) return null
  const relSource = source.relationships ?? source.edges
  if (relSource != null && !Array.isArray(relSource)) return null

  const seenNodes = new Set<string>()
  const nodes: GraphPayload['nodes'] = []
  for (const item of source.nodes) {
    if (!isRecord(item)) return null
    const elementId = field(item, ['element_id', 'elementId', 'id'])
    if (!elementId) return null
    if (seenNodes.has(elementId)) continue
    seenNodes.add(elementId)
    const properties = isRecord(item.properties) ? item.properties : {}
    const display = field(item, ['display_label', 'displayLabel', 'label', 'name', 'attributive_label'])
    nodes.push({
      element_id: elementId,
      labels: labelsOf(item),
      properties,
      ...(display ? { display_label: display } : {}),
    })
  }

  const seenRels = new Set<string>()
  const relationships: GraphRelationship[] = []
  for (const [index, item] of (relSource ?? []).entries()) {
    if (!isRecord(item)) return null
    const start = field(item, ['start', 'source', 'from'])
    const end = field(item, ['end', 'target', 'to'])
    if (!start || !end) continue
    const explicit = field(item, ['element_id', 'elementId', 'id'])
    const elementId = explicit ? (seenRels.has(explicit) ? null : explicit) : freshId(`rel-${index}`, seenRels)
    if (!elementId) continue
    seenRels.add(elementId)
    const type = field(item, ['type']) ?? field(item, ['label']) ?? 'RELATED'
    const caption = field(item, ['attributive_label', 'label'])
    const properties = isRecord(item.properties) ? { ...item.properties } : {}
    if (caption && caption !== type && typeof properties.attributive_label !== 'string') {
      properties.attributive_label = caption
    }
    relationships.push({ element_id: elementId, type, start, end, properties })
  }

  return { nodes, relationships }
}

function graphRecord(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null
  if (data.kind === 'table' || data.kind === 'response' || data.kind === 'summary') return null
  if (isRecord(data.graph) && Array.isArray(data.graph.nodes)) return data.graph
  if (Array.isArray(data.nodes)) return data
  return null
}

function labelsOf(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.labels)) {
    const labels = record.labels.flatMap((item) => {
      const label = text(item)
      return label ? [label] : []
    })
    if (labels.length > 0) return labels
  }
  const group = field(record, ['group'])
  return group ? [group] : ['NODE']
}

function field(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key])
    if (value) return value
  }
  return null
}

function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function freshId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) return base
  let n = 2
  while (seen.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}
