import type { ComponentType } from 'react'

export type ModuleKind = 'display' | 'action'

export type ModuleCategory = 'Data display' | 'Charts' | 'Feedback' | 'Inputs'

export type ConfigField = {
  key: string
  label: string
  input: 'text' | 'number' | 'textarea' | 'select' | 'field-list' | 'boolean'
  options?: { value: string; label: string }[]
  description?: string
}

export type SequencePauseParameter = {
  name: string
  is_required?: boolean
  value_type?: string
  format?: string
  options?: string[]
  auto_generate?: boolean
}

export type SequenceRunStep =
  | { status: 'inactive' }
  | { status: 'pending'; stateId: string; parameters: SequencePauseParameter[] }

export type ModuleViewProps = {
  config: Record<string, unknown>
  data: unknown
  onAction: (value: unknown) => Promise<boolean>
  acting: boolean
  /** Present when this module's action is a sequence, so a pause can be resumed. */
  sequenceRun?: (params: Record<string, unknown>, stateId?: string) => Promise<SequenceRunStep>
}

export type ModuleDefinition = {
  type: string
  title: string
  description: string
  mantineComponent: string
  category: ModuleCategory
  kind: ModuleKind
  defaultLayout: { w: number; h: number; minW?: number; minH?: number }
  defaultDataUrl: string
  defaultActionUrl: string
  defaultConfig: Record<string, unknown>
  fields: ConfigField[]
  expectedShape: string
  /** Stretch the view to the card body. The graph canvas needs a bounded height. */
  fill?: boolean
  View: ComponentType<ModuleViewProps>
}

export const moduleCategories: ModuleCategory[] = ['Data display', 'Charts', 'Feedback', 'Inputs']
