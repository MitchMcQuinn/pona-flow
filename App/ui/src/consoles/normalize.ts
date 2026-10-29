import { isRecord } from './modules/data'
import { createLiveView } from './views'
import type {
  ConsoleRecord,
  DashboardView,
  FormDashboardView,
  FormFieldDefinition,
  FormFieldType,
  LiveDashboardView,
  ModuleInstance,
  ModuleSourceKind,
  TriggerKind,
} from './types'

const fieldTypes: FormFieldType[] = ['text', 'number', 'textarea', 'checkbox', 'select']

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asOptionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isFieldType(value: unknown): value is FormFieldType {
  return typeof value === 'string' && fieldTypes.includes(value as FormFieldType)
}

function moduleSource(value: unknown): ModuleSourceKind {
  return value === 'sequence' ? 'sequence' : 'url'
}

function textField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return ''
}

function normalizeModule(value: unknown): ModuleInstance | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return null
  const layout = isRecord(value.layout) ? value.layout : {}
  const dataSequenceId = textField(value, ['dataSequenceId', 'data_sequence_id', 'sequenceId', 'sequence_id'])
  const actionSequenceId = textField(value, ['actionSequenceId', 'action_sequence_id'])
  return {
    id: value.id,
    type: value.type,
    title: typeof value.title === 'string' ? value.title : value.type,
    dataSource: dataSequenceId ? 'sequence' : moduleSource(value.dataSource),
    dataUrl: typeof value.dataUrl === 'string' ? value.dataUrl : '',
    dataSequenceId,
    actionSource: actionSequenceId ? 'sequence' : moduleSource(value.actionSource),
    actionUrl: typeof value.actionUrl === 'string' ? value.actionUrl : '',
    actionSequenceId,
    config: isRecord(value.config) ? value.config : {},
    layout: {
      x: asNumber(layout.x, 0),
      y: asNumber(layout.y, 0),
      w: asNumber(layout.w, 4),
      h: asNumber(layout.h, 4),
      minW: asOptionalNumber(layout.minW),
      minH: asOptionalNumber(layout.minH),
    },
  }
}

function normalizeField(value: unknown): FormFieldDefinition | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const name = typeof value.name === 'string' && value.name ? value.name : 'field'
  return {
    id: value.id,
    name,
    label: typeof value.label === 'string' && value.label ? value.label : name,
    type: isFieldType(value.type) ? value.type : 'text',
    required: value.required === true,
    options: typeof value.options === 'string' ? value.options : '',
    placeholder: typeof value.placeholder === 'string' ? value.placeholder : '',
    page: typeof value.page === 'number' && Number.isInteger(value.page) && value.page > 0 ? value.page : 0,
  }
}

function normalizeView(value: unknown): DashboardView | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const name = typeof value.name === 'string' && value.name ? value.name : 'View'
  if (value.kind === 'form') {
    const fields = Array.isArray(value.fields)
      ? value.fields.flatMap((field) => {
          const normalized = normalizeField(field)
          return normalized ? [normalized] : []
        })
      : []
    const view: FormDashboardView = {
      id: value.id,
      name,
      kind: 'form',
      dataSequenceId: typeof value.dataSequenceId === 'string' ? value.dataSequenceId : '',
      actionSequenceId: typeof value.actionSequenceId === 'string' ? value.actionSequenceId : '',
      submitLabel: typeof value.submitLabel === 'string' && value.submitLabel ? value.submitLabel : 'Submit',
      fields,
    }
    return view
  }
  const modules = Array.isArray(value.modules)
    ? value.modules.flatMap((module) => {
        const normalized = normalizeModule(module)
        return normalized ? [normalized] : []
      })
    : []
  const view: LiveDashboardView = { id: value.id, name, kind: 'live', modules }
  return view
}

export function consoleFromApi(row: {
  id?: string
  name?: string
  trigger_kind?: string
  listen_url?: string
  trigger_event_id?: string
  document?: { views?: unknown; activeViewId?: string }
}): ConsoleRecord {
  const rawViews = Array.isArray(row.document?.views) ? row.document.views : []
  let views = rawViews.flatMap((view) => {
    const normalized = normalizeView(view)
    return normalized ? [normalized] : []
  })
  if (views.length === 0) views = [createLiveView('Live')]
  const requested = row.document?.activeViewId
  const activeViewId = views.some((view) => view.id === requested) ? String(requested) : views[0].id
  const kind = row.trigger_kind
  const triggerKind: TriggerKind = kind === 'url' || kind === 'event' ? kind : ''
  return {
    id: row.id || '',
    name: row.name || 'Console',
    triggerKind,
    listenUrl: row.listen_url || '',
    triggerEventId: row.trigger_event_id || '',
    views,
    activeViewId,
  }
}

export type SequenceRef = { id: string; label: string; attributiveLabel?: string; kind: string }

function resolveSequenceRef(ref: string, catalog: SequenceRef[]) {
  const token = ref.trim()
  if (!token) return ''
  const byId = catalog.find((item) => item.id === token)
  if (byId) return byId.id
  const named = catalog.filter(
    (item) => item.label === token || (item.attributiveLabel && item.attributiveLabel === token),
  )
  const sequence = named.find((item) => item.kind === 'sequence')
  return (sequence ?? named[0])?.id ?? token
}

/** Point a module at a real sequence. A form with only a submit sequence uses that as its data sequence too. */
export function bindModuleSequences(module: ModuleInstance, catalog: SequenceRef[]): ModuleInstance {
  const actionSequenceId = resolveSequenceRef(module.actionSequenceId, catalog)
  let dataSequenceId = resolveSequenceRef(module.dataSequenceId, catalog)
  let dataSource = module.dataSource
  let actionSource = module.actionSource
  if (!dataSequenceId && actionSequenceId && (module.type === 'form' || module.dataSource === 'sequence')) {
    dataSequenceId = actionSequenceId
    dataSource = 'sequence'
  } else if (dataSequenceId) {
    dataSource = 'sequence'
  }
  if (actionSequenceId) actionSource = 'sequence'
  if (
    dataSequenceId === module.dataSequenceId &&
    actionSequenceId === module.actionSequenceId &&
    dataSource === module.dataSource &&
    actionSource === module.actionSource
  ) {
    return module
  }
  return { ...module, dataSequenceId, dataSource, actionSequenceId, actionSource }
}

export function documentFromRecord(record: ConsoleRecord) {
  return { views: record.views, activeViewId: record.activeViewId }
}
