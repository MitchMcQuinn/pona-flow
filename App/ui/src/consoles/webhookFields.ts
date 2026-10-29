import type { ModuleFormField, ModuleFormFieldType } from './modules/formFields'
import type { FormFieldDefinition, FormFieldType } from './types'

/** A caller-supplied sequence input, the same list the webhook helper shows. */
export type WebhookParameter = {
  name: string
  is_required?: boolean
  value_type?: string
  format?: string
  options?: string[]
  auto_generate?: boolean
}

type FieldKind = 'text' | 'textarea' | 'number' | 'checkbox' | 'radio'

type MappedField = {
  name: string
  label: string
  kind: FieldKind
  required: boolean
  options: string[]
  placeholder: string
}

/** Same emptiness rule as a sequence parameter binding: blank, null, or an empty list. */
function bindingValueEmpty(value: unknown) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function boundNames(values: Record<string, unknown> | undefined) {
  const names = new Set<string>()
  if (!values) return names
  for (const [key, value] of Object.entries(values)) {
    const name = key.trim()
    if (name && !bindingValueEmpty(value)) names.add(name)
  }
  return names
}

function optionNames(options: string[] | undefined) {
  if (!Array.isArray(options)) return []
  return options.map((option) => (typeof option === 'string' ? option.trim() : '')).filter(Boolean)
}

function formatHint(format: string | undefined) {
  const value = (format || '').trim()
  if (!value || value.toLowerCase() === 'any') return ''
  return value
}

function labelFromName(name: string) {
  const words = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return 'Field'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function formName(name: string) {
  const trimmed = name.trim()
  if (/^[a-zA-Z0-9_]+$/.test(trimmed)) return trimmed
  return trimmed.replace(/[^a-zA-Z0-9_]/g, '')
}

/**
 * Parameters a webhook caller still has to send: not minted ids, and not names
 * already baked into the sequence.
 */
export function callerFacingWebhookParameters(
  parameters: WebhookParameter[],
  parameterValues?: Record<string, unknown>,
) {
  const bound = boundNames(parameterValues)
  const seen = new Set<string>()
  const kept: WebhookParameter[] = []
  for (const parameter of parameters) {
    const name = (parameter.name || '').trim()
    if (!name || parameter.auto_generate || bound.has(name) || seen.has(name)) continue
    seen.add(name)
    kept.push({ ...parameter, name })
  }
  return kept
}

function sameNames(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const names = new Set(left)
  return right.every((name) => names.has(name))
}

/**
 * Group caller-supplied parameters into form pages.
 *
 * A page is one human-in-the-loop pause. Inputs on steps that run before the
 * next pause — including optional ones that would otherwise be skipped — belong
 * on the page submitted before those steps run. Later pauses stay on later
 * pages so the run actually stops and asks.
 */
export function webhookParameterPages(
  steps: WebhookParameter[][],
  parameterValues?: Record<string, unknown>,
  responseParameterNames?: string[],
) {
  const bound = boundNames(parameterValues)
  const blocked = new Set((responseParameterNames ?? []).map((name) => name.trim()).filter(Boolean))
  const seen = new Set<string>()
  const appearances: { parameter: WebhookParameter; stepIndex: number }[] = []
  steps.forEach((step, stepIndex) => {
    for (const parameter of step) {
      const name = (parameter.name || '').trim()
      if (!name || parameter.auto_generate || bound.has(name) || blocked.has(name) || seen.has(name)) continue
      seen.add(name)
      appearances.push({ parameter: { ...parameter, name }, stepIndex })
    }
  })

  const pauseSteps: number[] = []
  const byStep = new Map<number, WebhookParameter[]>()
  for (const appearance of appearances) {
    const list = byStep.get(appearance.stepIndex) ?? []
    list.push(appearance.parameter)
    byStep.set(appearance.stepIndex, list)
  }
  for (const stepIndex of [...byStep.keys()].sort((left, right) => left - right)) {
    if ((byStep.get(stepIndex) ?? []).some((parameter) => parameter.is_required === true)) pauseSteps.push(stepIndex)
  }

  const pageOf = (stepIndex: number) => {
    let page = 0
    for (let index = 0; index < pauseSteps.length; index += 1) {
      if (pauseSteps[index] <= stepIndex) page = index
    }
    return page
  }

  const pages: WebhookParameter[][] = []
  for (const appearance of appearances) {
    const page = pageOf(appearance.stepIndex)
    while (pages.length <= page) pages.push([])
    pages[page].push(appearance.parameter)
  }
  return pages.filter((page) => page.length > 0)
}

/**
 * After a page is submitted, decide whether the pause is the next planned page
 * or a different set of inputs the form has to ask for now.
 */
export function nextFormPage(input: { plannedNames: string[][]; cursor: number; pendingNames: string[] }) {
  const current = input.plannedNames[input.cursor] ?? []
  if (sameNames(current, input.pendingNames)) return { cursor: input.cursor, usePending: false }
  const next = input.plannedNames[input.cursor + 1]
  if (next && sameNames(next, input.pendingNames)) return { cursor: input.cursor + 1, usePending: false }
  return { cursor: input.cursor, usePending: true }
}

function mapParameter(parameter: WebhookParameter): MappedField | null {
  const name = formName(parameter.name)
  if (!name) return null
  const valueType = (parameter.value_type || 'string').trim().toLowerCase()
  const required = parameter.is_required === true
  const options = optionNames(parameter.options)
  const hint = formatHint(parameter.format)
  const base = { name, label: labelFromName(name), placeholder: hint }

  if (valueType === 'number' || valueType === 'integer') {
    return { ...base, kind: 'number', required, options: [] }
  }
  if (valueType === 'boolean') {
    return { ...base, kind: 'radio', required, options: ['true', 'false'], placeholder: '' }
  }
  if (valueType === 'radio') {
    return { ...base, kind: 'radio', required, options, placeholder: '' }
  }
  if (valueType === 'checkbox') {
    // A checkbox with no choices is a boolean, so it always posts true or false.
    return { ...base, kind: 'checkbox', required: options.length > 0 && required, options, placeholder: '' }
  }
  if (valueType === 'array' || valueType === 'object') {
    return { ...base, kind: 'textarea', required, options: [], placeholder: hint || 'JSON' }
  }
  return { ...base, kind: 'text', required, options: [] }
}

function mappedFields(parameters: WebhookParameter[]) {
  const seen = new Set<string>()
  const fields: MappedField[] = []
  for (const parameter of parameters) {
    const mapped = mapParameter(parameter)
    if (!mapped || seen.has(mapped.name)) continue
    seen.add(mapped.name)
    fields.push(mapped)
  }
  return fields
}

function formViewType(kind: FieldKind): FormFieldType {
  if (kind === 'radio') return 'select'
  return kind
}

export function formFieldsFromWebhookParameters(parameters: WebhookParameter[], newId: () => string) {
  return mappedFields(parameters).map((field): FormFieldDefinition => ({
    id: newId(),
    name: field.name,
    label: field.label,
    type: formViewType(field.kind),
    required: field.required,
    options: field.options.join(', '),
    placeholder: field.placeholder,
    page: 0,
  }))
}

export function formFieldsFromWebhookPages(pages: WebhookParameter[][], newId: () => string) {
  return pages.flatMap((page, pageIndex) =>
    formFieldsFromWebhookParameters(page, newId).map((field) => ({ ...field, page: pageIndex })),
  )
}

function moduleType(kind: FieldKind): ModuleFormFieldType {
  return kind
}

export function moduleFormFieldsFromWebhookParameters(parameters: WebhookParameter[]) {
  return mappedFields(parameters).map((field): ModuleFormField => ({
    name: field.name,
    label: field.label,
    type: moduleType(field.kind),
    options: field.kind === 'radio' || field.kind === 'checkbox' ? field.options : [],
    placeholder: field.placeholder,
    required: field.required,
    min: null,
    max: null,
    fields: [],
  }))
}

export function moduleFormFieldsFromWebhookPages(pages: WebhookParameter[][]) {
  return pages.flatMap((page, pageIndex) =>
    moduleFormFieldsFromWebhookParameters(page).map((field) => (pageIndex > 0 ? { ...field, page: pageIndex } : field)),
  )
}

