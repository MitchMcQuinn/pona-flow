import { isRecord } from './data'

export const moduleFormFieldTypes = ['text', 'textarea', 'number', 'checkbox', 'radio', 'select', 'array'] as const

export type ModuleFormFieldType = (typeof moduleFormFieldTypes)[number]

export type ModuleFormField = {
  name: string
  label: string
  type: ModuleFormFieldType
  options: string[]
  placeholder: string
  required: boolean
  min: number | null
  max: number | null
  fields: ModuleFormField[]
  /** Which human-in-the-loop pause asks for this field. Omitted on the first page. */
  page?: number
}

const maxFieldDepth = 8

export function emptyModuleFormField(index: number): ModuleFormField {
  return {
    name: `field${index}`,
    label: 'Field',
    type: 'text',
    options: [],
    placeholder: '',
    required: false,
    min: null,
    max: null,
    fields: [],
  }
}

export function usableOptions(field: ModuleFormField) {
  return field.options.map((option) => option.trim()).filter(Boolean)
}

function isFieldType(value: unknown): value is ModuleFormFieldType {
  return typeof value === 'string' && (moduleFormFieldTypes as readonly string[]).includes(value)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function optionsFrom(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean)
  }
  if (!Array.isArray(value)) return []
  return value.map((option) => {
    if (typeof option === 'string') return option
    if (typeof option === 'number' && Number.isFinite(option)) return String(option)
    if (isRecord(option) && typeof option.value === 'string') return option.value
    return ''
  })
}

function parseFieldList(parsed: unknown, depth: number): { fields: ModuleFormField[]; error: string | null } {
  if (!Array.isArray(parsed)) return { fields: [], error: 'Fields must be a JSON array.' }
  if (depth > maxFieldDepth) return { fields: [], error: 'Nested field arrays are too deep.' }
  const fields: ModuleFormField[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue
    const type = isFieldType(entry.type) ? entry.type : 'text'
    let nested: ModuleFormField[] = []
    if (type === 'array') {
      const child = parseFieldList(entry.fields === undefined ? [] : entry.fields, depth + 1)
      if (child.error) return child
      nested = child.fields
    }
    const page = finiteNumber(entry.page)
    fields.push({
      name: entry.name,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.name || 'Field',
      type,
      options: optionsFrom(entry.options),
      placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
      required: entry.required === true,
      min: type === 'number' ? finiteNumber(entry.min) : null,
      max: type === 'number' ? finiteNumber(entry.max) : null,
      fields: nested,
      ...(page != null && page > 0 && Number.isInteger(page) ? { page } : {}),
    })
  }
  return { fields, error: null }
}

export function parseModuleFormFields(value: unknown): { fields: ModuleFormField[]; error: string | null } {
  try {
    const parsed = typeof value === 'string' ? (value.trim() ? (JSON.parse(value) as unknown) : []) : value
    return parseFieldList(parsed, 0)
  } catch {
    return { fields: [], error: 'Fields JSON could not be parsed.' }
  }
}

function serializeField(field: ModuleFormField): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: field.name,
    label: field.label,
    type: field.type,
  }
  if ((field.type === 'select' || field.type === 'checkbox' || field.type === 'radio') && field.options.length > 0) {
    entry.options = field.options
  }
  if (field.type === 'number') {
    if (field.min != null) entry.min = field.min
    if (field.max != null) entry.max = field.max
  }
  if (field.type === 'array') entry.fields = field.fields.map(serializeField)
  if (field.type !== 'array' && field.placeholder.trim()) entry.placeholder = field.placeholder
  if (field.required) entry.required = true
  if (field.page != null && field.page > 0) entry.page = field.page
  return entry
}

export function serializeModuleFormFields(fields: ModuleFormField[]) {
  return JSON.stringify(fields.map(serializeField), null, 2)
}
