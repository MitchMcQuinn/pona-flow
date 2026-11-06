import type { FormDashboardView, FormFieldDefinition, LiveDashboardView, ModuleInstance } from './types'

export function createLiveView(name = 'live', modules: ModuleInstance[] = []): LiveDashboardView {
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'live',
    modules,
  }
}

export function createFormView(name = 'form'): FormDashboardView {
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'form',
    dataSequenceId: '',
    actionSequenceId: '',
    submitLabel: 'submit',
    fields: [
      field('note', 'note', 'text', true),
      field('owner', 'owner', 'text', false),
    ],
  }
}

export function createFormField(index: number): FormFieldDefinition {
  return field(`field${index}`, 'field', 'text', false)
}

function field(name: string, label: string, type: FormFieldDefinition['type'], required: boolean): FormFieldDefinition {
  return {
    id: crypto.randomUUID(),
    name,
    label,
    type,
    required,
    options: '',
    placeholder: '',
    page: 0,
  }
}
