import { useEffect, useRef, useState } from 'react'
import { Button, Code, Drawer, NumberInput, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { FieldListEditor } from './FieldListEditor'
import { serializeModuleFormFields } from '../modules/formFields'
import { getModuleDefinition } from '../modules/registry'
import { removeModule, updateModule, updateModuleConfig } from '../docStore'
import { useSequenceOptions } from '../sequenceOptions'
import { readCallerWebhookParameters } from '../readWebhookParameters'
import { moduleFormFieldsFromWebhookPages } from '../webhookFields'
import type { ModuleInstance, ModuleSourceKind } from '../types'

type ModuleInspectorProps = {
  spaceId: string
  viewId: string
  module: ModuleInstance | null
  opened: boolean
  onClose: () => void
}

const sourceChoices = [
  { value: 'url', label: 'URL' },
  { value: 'sequence', label: 'sequence' },
]

function asSource(value: string): ModuleSourceKind {
  return value === 'sequence' ? 'sequence' : 'url'
}

export function ModuleInspector({ spaceId, viewId, module, opened, onClose }: ModuleInspectorProps) {
  const definition = module ? getModuleDefinition(module.type) : undefined
  const sequences = useSequenceOptions()
  const requests = useRef(new Map<string, number>())
  const activeModuleId = useRef(module?.id ?? '')
  activeModuleId.current = module?.id ?? ''
  const [matching, setMatching] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    setNote(null)
    setMatching(false)
  }, [module?.id])

  const patch = (next: Partial<ModuleInstance>) => {
    if (!module) return
    updateModule(viewId, module.id, next)
  }

  const matchFormFields = (sequenceId: string) => {
    if (!module || module.type !== 'form' || !sequenceId) return
    const moduleId = module.id
    const token = (requests.current.get(moduleId) ?? 0) + 1
    requests.current.set(moduleId, token)
    setMatching(true)
    setNote(null)
    const stillCurrent = () => requests.current.get(moduleId) === token
    readCallerWebhookParameters(spaceId, sequenceId)
      .then(({ pages }) => {
        if (!stillCurrent()) return
        updateModuleConfig(
          viewId,
          moduleId,
          'fields',
          serializeModuleFormFields(moduleFormFieldsFromWebhookPages(pages)),
        )
        if (activeModuleId.current !== moduleId) return
        setNote(
          pages.length === 0
            ? 'this sequence has no caller-supplied webhook parameters.'
            : pages.length > 1
              ? `split into ${pages.length} pages, one for each time the sequence pauses for input.`
              : null,
        )
      })
      .catch((reason: unknown) => {
        if (!stillCurrent() || activeModuleId.current !== moduleId) return
        notifications.show({
          color: 'red',
          title: 'webhook parameters unavailable',
          message: reason instanceof Error ? reason.message : 'could not read the webhook parameters for this sequence.',
        })
      })
      .finally(() => {
        if (stillCurrent() && activeModuleId.current === moduleId) setMatching(false)
      })
  }

  const setConfig = (key: string, value: unknown) => {
    if (!module) return
    patch({ config: { ...module.config, [key]: value } })
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" title={module?.title ?? 'module'} size="md">
      {module ? (
        <Stack gap="sm">
          <Text className="section-label">
            {definition ? `${definition.mantineComponent} · ${definition.category}` : module.type}
          </Text>
          <TextInput label="title" value={module.title} onChange={(event) => patch({ title: event.currentTarget.value })} />
          <Stack gap="xs">
            <Text className="section-label">data</Text>
            <SegmentedControl
              fullWidth
              value={module.dataSource}
              data={sourceChoices}
              onChange={(value) => patch({ dataSource: asSource(value) })}
            />
            {module.dataSource === 'sequence' ? (
              <Select
                label="data sequence"
                description="runs when the console refreshes. the result is this module's data."
                placeholder="choose a sequence"
                data={sequences}
                value={module.dataSequenceId || null}
                searchable
                clearable
                nothingFoundMessage="no sequences"
                comboboxProps={{ withinPortal: false, hideDetached: false, width: 'target', zIndex: 1200 }}
                onChange={(value) => patch({ dataSequenceId: value ?? '' })}
              />
            ) : (
              <TextInput
                label="data URL"
                description="GET this URL when the console refreshes."
                placeholder="https://example.com/stat"
                value={module.dataUrl}
                onChange={(event) => patch({ dataUrl: event.currentTarget.value })}
              />
            )}
          </Stack>
          {definition?.kind === 'action' ? (
            <Stack gap="xs">
              <Text className="section-label">action</Text>
              <SegmentedControl
                fullWidth
                value={module.actionSource}
                data={sourceChoices}
                onChange={(value) => {
                  const source = asSource(value)
                  patch({ actionSource: source })
                  if (source === 'sequence' && module.actionSequenceId) matchFormFields(module.actionSequenceId)
                }}
              />
              {module.actionSource === 'sequence' ? (
                <Select
                  label="action sequence"
                  description={
                    module.type === 'form'
                      ? 'runs on a change. choosing a sequence sets the form fields from its webhook parameters.'
                      : "runs on a change. a posted record's keys are the sequence parameters."
                  }
                  placeholder="choose a sequence"
                  data={sequences}
                  value={module.actionSequenceId || null}
                  searchable
                  clearable
                  nothingFoundMessage="no sequences"
                  comboboxProps={{ withinPortal: false, hideDetached: false, width: 'target', zIndex: 1200 }}
                  onChange={(value) => {
                    const sequenceId = value ?? ''
                    patch({ actionSequenceId: sequenceId })
                    if (sequenceId) matchFormFields(sequenceId)
                    else setNote(null)
                  }}
                />
              ) : (
                <TextInput
                  label="action URL"
                  description="POST changes here as JSON."
                  placeholder="https://example.com/actions"
                  value={module.actionUrl}
                  onChange={(event) => patch({ actionUrl: event.currentTarget.value })}
                />
              )}
              {module.type === 'form' && module.actionSource === 'sequence' && matching ? (
                <Text size="sm" c="dimmed">
                  reading webhook parameters…
                </Text>
              ) : null}
              {module.type === 'form' && module.actionSource === 'sequence' && note ? (
                <Text size="sm" c="dimmed">
                  {note}
                </Text>
              ) : null}
            </Stack>
          ) : null}
          {definition?.fields.map((field) => {
            const value = module.config[field.key]
            if (field.input === 'field-list') {
              return (
                <FieldListEditor
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(next) => setConfig(field.key, next)}
                />
              )
            }
            if (field.input === 'textarea') {
              return (
                <Textarea
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  minRows={4}
                  autosize
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setConfig(field.key, event.currentTarget.value)}
                />
              )
            }
            if (field.input === 'number') {
              return (
                <NumberInput
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
                  onChange={(next) => setConfig(field.key, next)}
                />
              )
            }
            if (field.input === 'boolean') {
              return (
                <Switch
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  checked={value !== false}
                  onChange={(event) => setConfig(field.key, event.currentTarget.checked)}
                />
              )
            }
            if (field.input === 'select') {
              return (
                <Select
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  data={field.options ?? []}
                  value={typeof value === 'string' ? value : null}
                  allowDeselect={false}
                  onChange={(next) => setConfig(field.key, next ?? '')}
                />
              )
            }
            return (
              <TextInput
                key={field.key}
                label={field.label}
                description={field.description}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setConfig(field.key, event.currentTarget.value)}
              />
            )
          })}
          {definition ? (
            <div>
              <Text size="sm" fw={500} mb={4}>
                expected response
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {definition.expectedShape}
              </Code>
            </div>
          ) : null}
          <Text size="xs" c="dimmed">
            a URL is fetched in the browser, so a cross-origin data URL needs CORS. a sequence runs in this space with
            console_id, view_id, and module_id. an action sequence also receives value, or the posted record's keys.
          </Text>
          <Button
            color="red"
            variant="light"
            onClick={() => {
              removeModule(viewId, module.id)
              onClose()
            }}
          >
            remove module
          </Button>
        </Stack>
      ) : null}
    </Drawer>
  )
}
