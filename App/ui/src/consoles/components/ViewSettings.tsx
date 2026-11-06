import { useEffect, useRef, useState } from 'react'
import { Button, Drawer, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  addFormField,
  moveFormField,
  removeFormField,
  removeView,
  setFormFields,
  updateFormField,
  updateView,
} from '../docStore'
import { useSequenceOptions } from '../sequenceOptions'
import { readCallerWebhookParameters } from '../readWebhookParameters'
import { formFieldsFromWebhookPages } from '../webhookFields'
import type { DashboardView, FormFieldType } from '../types'

const fieldTypeOptions: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: 'text' },
  { value: 'textarea', label: 'text area' },
  { value: 'number', label: 'number' },
  { value: 'checkbox', label: 'checkbox' },
  { value: 'select', label: 'select' },
]

type ViewSettingsProps = {
  spaceId: string
  view: DashboardView
  canDelete: boolean
  opened: boolean
  onClose: () => void
}

export function ViewSettings({ spaceId, view, canDelete, opened, onClose }: ViewSettingsProps) {
  const sequences = useSequenceOptions()
  const names = view.kind === 'form' ? view.fields.map((field) => field.name) : []
  const sequenceData = sequences
  const requests = useRef(new Map<string, number>())
  const activeViewId = useRef(view.id)
  activeViewId.current = view.id
  const [matching, setMatching] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    setNote(null)
    setMatching(false)
  }, [view.id])

  const chooseActionSequence = (value: string | null) => {
    if (view.kind !== 'form') return
    const sequenceId = value ?? ''
    const viewId = view.id
    updateView(viewId, { actionSequenceId: sequenceId })
    if (!sequenceId) {
      setNote(null)
      return
    }
    const token = (requests.current.get(viewId) ?? 0) + 1
    requests.current.set(viewId, token)
    setMatching(true)
    setNote(null)
    const stillCurrent = () => requests.current.get(viewId) === token
    readCallerWebhookParameters(spaceId, sequenceId)
      .then(({ pages }) => {
        if (!stillCurrent()) return
        setFormFields(
          viewId,
          formFieldsFromWebhookPages(pages, () => crypto.randomUUID()),
        )
        if (activeViewId.current !== viewId) return
        setNote(
          pages.length === 0
            ? 'this sequence has no caller-supplied webhook parameters.'
            : pages.length > 1
              ? `split into ${pages.length} pages, one for each time the sequence pauses for input.`
              : null,
        )
      })
      .catch((reason: unknown) => {
        if (!stillCurrent() || activeViewId.current !== viewId) return
        notifications.show({
          color: 'red',
          title: 'webhook parameters unavailable',
          message: reason instanceof Error ? reason.message : 'could not read the webhook parameters for this sequence.',
        })
      })
      .finally(() => {
        if (stillCurrent() && activeViewId.current === viewId) setMatching(false)
      })
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" title={view.name} size="md">
      <Stack gap="sm">
        <Text className="section-label">{view.kind} view</Text>
        <TextInput
          label="name"
          value={view.name}
          onChange={(event) => updateView(view.id, { name: event.currentTarget.value })}
        />
        {view.kind === 'form' ? (
          <>
            <Select
              label="data sequence"
              description="runs when the console refreshes. the result prefills matching field names."
              placeholder="none"
              data={sequenceData}
              value={view.dataSequenceId || null}
              clearable
              searchable
              onChange={(value) => updateView(view.id, { dataSequenceId: value ?? '' })}
            />
            <Select
              label="action sequence"
              description="runs on submit. choosing a sequence sets these fields from its webhook parameters."
              placeholder="none"
              data={sequenceData}
              value={view.actionSequenceId || null}
              clearable
              searchable
              onChange={chooseActionSequence}
            />
            {matching ? (
              <Text size="sm" c="dimmed">
                reading webhook parameters…
              </Text>
            ) : null}
            {note ? (
              <Text size="sm" c="dimmed">
                {note}
              </Text>
            ) : null}
            <TextInput
              label="submit label"
              value={view.submitLabel}
              onChange={(event) => updateView(view.id, { submitLabel: event.currentTarget.value })}
            />
            <Group justify="space-between">
              <Text className="section-label">fields</Text>
              <Button size="xs" variant="default" onClick={() => addFormField(view.id)}>
                add field
              </Button>
            </Group>
            {view.fields.map((field, index) => {
              const duplicate = field.name !== '' && names.filter((name) => name === field.name).length > 1
              return (
                <Stack key={field.id} gap="xs" className="field-editor">
                  {view.fields.some((item) => item.page > 0) ? (
                    <Text size="xs" c="dimmed">
                      page {field.page + 1}
                    </Text>
                  ) : null}
                  <TextInput
                    label="label"
                    value={field.label}
                    onChange={(event) => updateFormField(view.id, field.id, { label: event.currentTarget.value })}
                  />
                  <TextInput
                    label="name"
                    description={duplicate ? 'another field already uses this name.' : 'sequence parameter name.'}
                    error={duplicate ? 'duplicate name' : undefined}
                    value={field.name}
                    onChange={(event) =>
                      updateFormField(view.id, field.id, {
                        name: event.currentTarget.value.replace(/[^a-zA-Z0-9_]/g, ''),
                      })
                    }
                  />
                  <Select
                    label="type"
                    data={fieldTypeOptions}
                    value={field.type}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value === 'text' || value === 'textarea' || value === 'number' || value === 'checkbox' || value === 'select') {
                        updateFormField(view.id, field.id, { type: value })
                      }
                    }}
                  />
                  {field.type === 'select' || field.type === 'checkbox' ? (
                    <TextInput
                      label="options"
                      description="comma-separated. a checkbox with options lets the user pick any of them."
                      value={field.options}
                      onChange={(event) => updateFormField(view.id, field.id, { options: event.currentTarget.value })}
                    />
                  ) : null}
                  <TextInput
                    label="placeholder"
                    value={field.placeholder}
                    onChange={(event) =>
                      updateFormField(view.id, field.id, { placeholder: event.currentTarget.value })
                    }
                  />
                  <Group justify="space-between">
                    <Switch
                      label="required"
                      checked={field.required}
                      onChange={(event) =>
                        updateFormField(view.id, field.id, { required: event.currentTarget.checked })
                      }
                    />
                    <Group gap="xs">
                      <Button
                        size="compact-xs"
                        variant="default"
                        disabled={index === 0}
                        onClick={() => moveFormField(view.id, field.id, -1)}
                      >
                        up
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="default"
                        disabled={index === view.fields.length - 1}
                        onClick={() => moveFormField(view.id, field.id, 1)}
                      >
                        down
                      </Button>
                      <Button
                        size="compact-xs"
                        color="red"
                        variant="light"
                        onClick={() => removeFormField(view.id, field.id)}
                      >
                        remove
                      </Button>
                    </Group>
                  </Group>
                </Stack>
              )
            })}
          </>
        ) : (
          <Text size="sm" c="dimmed">
            a live view is a mantine module grid. it refetches each module when the console refreshes.
          </Text>
        )}
        <Button
          color="red"
          variant="light"
          disabled={!canDelete}
          onClick={() => {
            removeView(view.id)
            onClose()
          }}
        >
          delete view
        </Button>
      </Stack>
    </Drawer>
  )
}
