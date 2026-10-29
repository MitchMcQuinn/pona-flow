/** Context keys plus a posted record's fields, or a single `value` for anything else. */
export function actionSequenceParams(value: unknown, context: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...context }
  if (isRecord(value)) {
    Object.assign(params, value)
    return params
  }
  if (value !== undefined) params.value = value
  return params
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function configString(config: Record<string, unknown>, key: string, fallback = ''): string {
  const value = config[key]
  return typeof value === 'string' ? value : fallback
}

export function pickPath(data: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (!trimmed) return data
  return trimmed.split('.').reduce<unknown>((current, key) => {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    return (current as Record<string, unknown>)[key]
  }, data)
}

export function asChartRows(data: unknown): Record<string, unknown>[] | null {
  const source = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.rows)
      ? data.rows
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : null
  if (!source) return null
  const rows = source.filter(isRecord)
  return rows.length === source.length ? rows : null
}

export type SequenceFieldLine = { key: string; value: string; numeric: boolean }

/** Scalar columns from a one-row sequence result, so a text module can show them. */
export function sequenceFieldLines(data: unknown): SequenceFieldLine[] {
  if (!isRecord(data) || !Array.isArray(data.rows) || data.rows.length !== 1) return []
  const row = data.rows[0]
  if (!isRecord(row)) return []
  const lines: SequenceFieldLine[] = []
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      lines.push({ key, value: String(value), numeric: true })
    } else if (typeof value === "string" || typeof value === "boolean") {
      lines.push({ key, value: String(value), numeric: false })
    } else if (Array.isArray(value)) {
      lines.push({ key, value: `${value.length} items`, numeric: false })
    }
  }
  return lines
}

export function displayText(data: unknown, keys: string[]): string | null {
  if (typeof data === 'string' || typeof data === 'number') return String(data)
  if (!isRecord(data)) return null
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
  return null
}

/** A flat text field, or the same field on a query result that is one row. */
export function moduleText(data: unknown, keys: string[]): string | null {
  const direct = displayText(data, keys)
  if (direct != null) return direct
  if (!isRecord(data) || !Array.isArray(data.rows) || data.rows.length !== 1) return null
  return displayText(data.rows[0], keys)
}
