export type GridLayout = {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export type ModuleSourceKind = 'url' | 'sequence'

export type ModuleInstance = {
  id: string
  type: string
  title: string
  /** Which saved value supplies this module's data. The other value is kept for switching back. */
  dataSource: ModuleSourceKind
  dataUrl: string
  dataSequenceId: string
  /** Which saved value receives an action module's change. */
  actionSource: ModuleSourceKind
  actionUrl: string
  actionSequenceId: string
  config: Record<string, unknown>
  layout: GridLayout
}

export type FormFieldType = 'text' | 'number' | 'textarea' | 'checkbox' | 'select'

export type FormFieldDefinition = {
  id: string
  name: string
  label: string
  type: FormFieldType
  required: boolean
  options: string
  placeholder: string
  /** Which human-in-the-loop pause asks for this field. Page 0 is the first submit. */
  page: number
}

export type LiveDashboardView = {
  id: string
  name: string
  kind: 'live'
  modules: ModuleInstance[]
}

export type FormDashboardView = {
  id: string
  name: string
  kind: 'form'
  dataSequenceId: string
  actionSequenceId: string
  submitLabel: string
  fields: FormFieldDefinition[]
}

export type DashboardView = LiveDashboardView | FormDashboardView

export type TriggerKind = '' | 'url' | 'event'

/** One console open in the editor. The catalog row's document is `views` + `activeViewId`. */
export type ConsoleRecord = {
  id: string
  name: string
  triggerKind: TriggerKind
  listenUrl: string
  triggerEventId: string
  views: DashboardView[]
  activeViewId: string
}
