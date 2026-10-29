import { useSyncExternalStore } from 'react'
import { createFormField, createFormView, createLiveView } from './views'
import type {
  ConsoleRecord,
  DashboardView,
  FormDashboardView,
  FormFieldDefinition,
  LiveDashboardView,
  ModuleInstance,
  TriggerKind,
} from './types'

export type ConsolePatch = Partial<Omit<ConsoleRecord, 'id' | 'views' | 'activeViewId'>> & {
  views?: DashboardView[]
  activeViewId?: string
}

let current: ConsoleRecord | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot() {
  return current
}

export function useConsoleRecord() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function hydrateConsole(record: ConsoleRecord | null) {
  current = record
  emit()
}

function update(patch: ConsolePatch) {
  if (!current) return
  current = { ...current, ...patch }
  emit()
}

function replaceViews(views: DashboardView[], activeViewId?: string) {
  if (!current) return
  update({ views, activeViewId: activeViewId ?? current.activeViewId })
}

export function updateConsole(patch: ConsolePatch) {
  update(patch)
}

export function addView(kind: 'live' | 'form', name: string) {
  if (!current) return null
  const view = kind === 'form' ? createFormView(name || 'Form') : createLiveView(name || 'Live')
  replaceViews([...current.views, view], view.id)
  return view
}

export function setActiveView(viewId: string) {
  if (!current || !current.views.some((view) => view.id === viewId)) return
  if (current.activeViewId === viewId) return
  update({ activeViewId: viewId })
}

export function updateView(
  viewId: string,
  patch: {
    name?: string
    dataSequenceId?: string
    actionSequenceId?: string
    submitLabel?: string
  },
) {
  if (!current) return
  replaceViews(
    current.views.map((view) => {
      if (view.id !== viewId) return view
      if (view.kind === 'live') return { ...view, name: patch.name ?? view.name }
      return {
        ...view,
        name: patch.name ?? view.name,
        dataSequenceId: patch.dataSequenceId ?? view.dataSequenceId,
        actionSequenceId: patch.actionSequenceId ?? view.actionSequenceId,
        submitLabel: patch.submitLabel ?? view.submitLabel,
      }
    }),
  )
}

export function removeView(viewId: string) {
  if (!current || current.views.length <= 1) return
  const views = current.views.filter((view) => view.id !== viewId)
  const activeViewId = current.activeViewId === viewId ? views[0].id : current.activeViewId
  replaceViews(views, activeViewId)
}

function mapLiveModules(viewId: string, mapper: (modules: ModuleInstance[]) => ModuleInstance[]) {
  if (!current) return
  let changed = false
  const views = current.views.map((view) => {
    if (view.kind !== 'live' || view.id !== viewId) return view
    const modules = mapper(view.modules)
    if (modules === view.modules) return view
    changed = true
    return { ...view, modules }
  })
  if (changed) replaceViews(views)
}

export function rebindModules(bind: (module: ModuleInstance) => ModuleInstance) {
  if (!current) return
  let changed = false
  const views = current.views.map((view) => {
    if (view.kind !== 'live') return view
    let moduleChanged = false
    const modules = view.modules.map((module) => {
      const next = bind(module)
      if (next !== module) moduleChanged = true
      return next
    })
    if (!moduleChanged) return view
    changed = true
    return { ...view, modules }
  })
  if (changed) replaceViews(views)
}

export function addModule(viewId: string, module: ModuleInstance) {
  mapLiveModules(viewId, (modules) => [...modules, module])
}

export function updateModule(
  viewId: string,
  moduleId: string,
  patch: Partial<Omit<ModuleInstance, 'id' | 'type'>>,
) {
  mapLiveModules(viewId, (modules) =>
    modules.map((module) => {
      if (module.id !== moduleId) return module
      return {
        ...module,
        ...patch,
        config: patch.config ?? module.config,
        layout: patch.layout ? { ...module.layout, ...patch.layout } : module.layout,
      }
    }),
  )
}

export function updateModuleLayouts(
  viewId: string,
  layout: readonly { i: string; x: number; y: number; w: number; h: number }[],
) {
  mapLiveModules(viewId, (modules) => {
    let changed = false
    const next = modules.map((module) => {
      const item = layout.find((entry) => entry.i === module.id)
      if (!item) return module
      if (
        item.x === module.layout.x &&
        item.y === module.layout.y &&
        item.w === module.layout.w &&
        item.h === module.layout.h
      ) {
        return module
      }
      changed = true
      return { ...module, layout: { ...module.layout, x: item.x, y: item.y, w: item.w, h: item.h } }
    })
    return changed ? next : modules
  })
}

export function removeModule(viewId: string, moduleId: string) {
  mapLiveModules(viewId, (modules) => modules.filter((module) => module.id !== moduleId))
}

function mapForm(viewId: string, mapper: (view: FormDashboardView) => FormDashboardView) {
  if (!current) return
  replaceViews(
    current.views.map((view) => (view.kind === 'form' && view.id === viewId ? mapper(view) : view)),
  )
}

export function setFormFields(viewId: string, fields: FormFieldDefinition[]) {
  mapForm(viewId, (view) => ({ ...view, fields }))
}

export function updateModuleConfig(viewId: string, moduleId: string, key: string, value: unknown) {
  mapLiveModules(viewId, (modules) => {
    const index = modules.findIndex((module) => module.id === moduleId)
    const module = modules[index]
    if (!module || module.config[key] === value) return modules
    const next = modules.slice()
    next[index] = { ...module, config: { ...module.config, [key]: value } }
    return next
  })
}

export function addFormField(viewId: string) {
  mapForm(viewId, (view) => {
    const page = view.fields.reduce((max, field) => Math.max(max, field.page), 0)
    return {
      ...view,
      fields: [...view.fields, { ...createFormField(view.fields.length + 1), page }],
    }
  })
}

export function updateFormField(
  viewId: string,
  fieldId: string,
  patch: Partial<Omit<FormFieldDefinition, 'id'>>,
) {
  mapForm(viewId, (view) => ({
    ...view,
    fields: view.fields.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)),
  }))
}

export function moveFormField(viewId: string, fieldId: string, direction: -1 | 1) {
  mapForm(viewId, (view) => {
    const index = view.fields.findIndex((field) => field.id === fieldId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= view.fields.length) return view
    const fields = [...view.fields]
    const [removed] = fields.splice(index, 1)
    if (!removed) return view
    fields.splice(nextIndex, 0, removed)
    return { ...view, fields }
  })
}

export function removeFormField(viewId: string, fieldId: string) {
  mapForm(viewId, (view) => ({
    ...view,
    fields: view.fields.filter((field) => field.id !== fieldId),
  }))
}

export function isTriggerKind(value: string): value is TriggerKind {
  return value === '' || value === 'url' || value === 'event'
}

export type { LiveDashboardView }
