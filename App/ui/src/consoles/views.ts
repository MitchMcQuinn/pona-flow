import type { FormDashboardView, FormFieldDefinition, LiveDashboardView, ModuleInstance } from './types'

export function createLiveView(name = 'Live', modules: ModuleInstance[] = []): LiveDashboardView {
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'live',
    modules,
  }
}

export function createFormView(name = 'Form'): FormDashboardView {
  return {
    id: crypto.randomUUID(),
    name,
    kind: 'form',
    dataSequenceId: '',
    actionSequenceId: '',
    submitLabel: 'Submit',
    fields: [
      field('note', 'Note', 'text', true),
      field('owner', 'Owner', 'text', false),
    ],
  }
}

export function createFormField(index: number): FormFieldDefinition {
  return field(`field${index}`, 'Field', 'text', false)
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
