import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Flex, Group, NumberInput, Radio, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ShapeNote } from '../components/ShapeNote'
import { nextFormPage, moduleFormFieldsFromWebhookParameters } from '../webhookFields'
import { configString, displayText, isRecord } from './data'
import { parseModuleFormFields, usableOptions, type ModuleFormField } from './formFields'
import type { ModuleViewProps } from './types'

const choiceShape = '{ "value": "Week", "options": ["Day", "Week", "Month"] }'
const formShape = '{ "values": { "note": "Dock 2 is clear" } }'

function optionList(data: unknown, fallback: string): string[] {
  if (isRecord(data) && Array.isArray(data.options)) {
    const options = data.options
      .map((option) => {
        if (typeof option === 'string') return option
        if (isRecord(option) && typeof option.value === 'string') return option.value
        return ''
      })
      .filter(Boolean)
    if (options.length > 0) return options
  }
  return fallback
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)
}

function booleanValue(data: unknown, fallback = false) {
  if (typeof data === 'boolean') return data
  if (isRecord(data) && typeof data.value === 'boolean') return data.value
  return fallback
}

function stringValue(data: unknown) {
  if (typeof data === 'string') return data
  if (isRecord(data) && typeof data.value === 'string') return data.value
  return ''
}

function numberValue(data: unknown) {
  if (typeof data === 'number' && Number.isFinite(data)) return data
  if (isRecord(data)) {
    const value = typeof data.value === 'number' ? data.value : Number(data.value)
    if (Number.isFinite(value)) return value
  }
  return null
}

function actionPayload(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return 'click'
  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return trimmed
    }
  }
  return trimmed
}

type FieldRecord = { [key: string]: FieldValue }
type FieldValue = string | number | boolean | string[] | FieldRecord[]

export function ButtonModule({ data, config, onAction, acting }: ModuleViewProps) {
  const label = displayText(data, ['label']) || configString(config, 'label', 'Run')
  const color = configString(config, 'color', 'accent')
  return (
    <Flex h="100%" align="center">
      <Button color={color} loading={acting} onClick={() => void onAction(actionPayload(configString(config, 'payload', 'click')))}>
        {label}
      </Button>
    </Flex>
  )
}

export function SwitchModule({ data, config, onAction, acting }: ModuleViewProps) {
  const remote = booleanValue(data)
  const [pending, setPending] = useState<{ source: unknown; value: boolean } | null>(null)
  const checked = pending != null && pending.source === data ? pending.value : remote
  const label = (isRecord(data) && typeof data.label === 'string' ? data.label : '') || configString(config, 'label', 'Enabled')

  return (
    <Flex h="100%" align="center">
      <Switch
        checked={checked}
        disabled={acting}
        label={label}
        onChange={(event) => {
          const next = event.currentTarget.checked
          setPending({ source: data, value: next })
          void onAction(next).then((ok) => {
            if (!ok) setPending(null)
          })
        }}
      />
    </Flex>
  )
}

export function CheckboxModule({ data, config, onAction, acting }: ModuleViewProps) {
  const remote = booleanValue(data)
  const [pending, setPending] = useState<{ source: unknown; value: boolean } | null>(null)
  const checked = pending != null && pending.source === data ? pending.value : remote
  const label = (isRecord(data) && typeof data.label === 'string' ? data.label : '') || configString(config, 'label', 'Checked')

  return (
    <Flex h="100%" align="center">
      <Checkbox
        checked={checked}
        disabled={acting}
        label={label}
        onChange={(event) => {
          const next = event.currentTarget.checked
          setPending({ source: data, value: next })
          void onAction(next).then((ok) => {
            if (!ok) setPending(null)
          })
        }}
      />
    </Flex>
  )
}

export function SegmentedModule({ data, config, onAction, acting }: ModuleViewProps) {
  const options = optionList(data, configString(config, 'options', 'Day, Week, Month'))
  if (options.length === 0) return <ShapeNote expected={choiceShape} />
  const remote = stringValue(data)
  const value = options.includes(remote) ? remote : options[0]

  return (
    <Flex h="100%" align="center">
      <SegmentedControl
        data={options}
        value={value}
        disabled={acting}
        onChange={(next) => void onAction(next)}
      />
    </Flex>
  )
}

export function SelectModule({ data, config, onAction, acting }: ModuleViewProps) {
  const options = optionList(data, configString(config, 'options', ''))
  if (options.length === 0) return <ShapeNote expected={choiceShape} />
  const remote = stringValue(data)
  const value = options.includes(remote) ? remote : null
  const label = configString(config, 'label', 'Choice')

  return (
    <Select
      label={label}
      data={options}
      value={value}
      disabled={acting}
      allowDeselect={false}
      onChange={(next) => {
        if (next != null) void onAction(next)
      }}
    />
  )
}

export function NumberModule({ data, config, onAction, acting }: ModuleViewProps) {
  const remote = numberValue(data)
  const [draft, setDraft] = useState<{ source: unknown; value: number | string } | null>(null)
  const value = draft != null && draft.source === data ? draft.value : (remote ?? '')
  const label = (isRecord(data) && typeof data.label === 'string' ? data.label : '') || configString(config, 'label', 'Value')

  return (
    <NumberInput
      label={label}
      value={value}
      disabled={acting}
      onChange={(next) => setDraft({ source: data, value: next })}
      onBlur={() => {
        const next = typeof value === 'number' ? value : Number(value)
        if (Number.isFinite(next) && next !== remote) void onAction(next)
      }}
    />
  )
}

function valuesFrom(data: unknown, fields: ModuleFormField[], unwrapValues = true): FieldRecord {
  const source = isRecord(data) ? (unwrapValues && isRecord(data.values) ? data.values : data) : {}
  const next: FieldRecord = {}
  for (const field of fields) {
    if (!field.name) continue
    next[field.name] = valueFromField(field, source[field.name])
  }
  return next
}

function valueFromField(field: ModuleFormField, raw: unknown): FieldValue {
  if (field.type === 'array') {
    if (!Array.isArray(raw)) return []
    return raw.filter(isRecord).map((item) => valuesFrom(item, field.fields, false))
  }
  if (field.type === 'checkbox' && field.options.length > 0) {
    if (Array.isArray(raw)) return raw.map((item) => String(item))
    if (typeof raw === 'string' && raw.trim()) {
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    return []
  }
  if (field.type === 'checkbox') return raw === true || raw === 'true'
  if (field.type === 'number') return finiteOrBlank(raw)
  return raw == null ? '' : String(raw)
}

function finiteOrBlank(raw: unknown): number | '' {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return ''
}

function asNumber(value: FieldValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function asFieldRecords(value: FieldValue | undefined): FieldRecord[] {
  if (!Array.isArray(value)) return []
  const records: FieldRecord[] = []
  for (const item of value) {
    if (isRecord(item)) records.push(item as FieldRecord)
  }
  return records
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => sameValue(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]))
  }
  return false
}

function collectErrors(fields: ModuleFormField[], values: FieldRecord, prefix = ''): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    if (!field.name) continue
    const path = prefix ? `${prefix}.${field.name}` : field.name
    const value = values[field.name]
    if (field.type === 'array') {
      const items = asFieldRecords(value)
      if (field.required && items.length === 0) errors[path] = 'Add at least one item'
      items.forEach((item, index) => Object.assign(errors, collectErrors(field.fields, item, `${path}.${index}`)))
      continue
    }
    if (field.type === 'number') {
      const numeric = asNumber(value)
      if (numeric == null) {
        if (field.required) errors[path] = 'Required'
      } else if (field.min != null && numeric < field.min) errors[path] = `Minimum is ${field.min}`
      else if (field.max != null && numeric > field.max) errors[path] = `Maximum is ${field.max}`
      continue
    }
    if (field.type === 'checkbox' && field.options.length > 0) {
      if (field.required && (!Array.isArray(value) || value.length === 0)) errors[path] = 'Required'
      continue
    }
    if (field.type === 'checkbox') {
      if (field.required && value !== true) errors[path] = 'Required'
      continue
    }
    if (field.required && (value == null || value === '')) errors[path] = 'Required'
  }
  return errors
}

function postedRecord(fields: ModuleFormField[], values: FieldRecord): FieldRecord {
  const payload: FieldRecord = {}
  for (const field of fields) {
    if (!field.name) continue
    payload[field.name] = postedValue(field, values[field.name])
  }
  return payload
}

function postedValue(field: ModuleFormField, value: FieldValue | undefined): FieldValue {
  if (field.type === 'array') {
    const items = asFieldRecords(value)
    return items.map((item) => postedRecord(field.fields, item))
  }
  if (field.type === 'checkbox' && field.options.length > 0) {
    const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    const allowed = new Set(usableOptions(field))
    return selected.filter((item) => allowed.has(item))
  }
  if (field.type === 'checkbox') return value === true
  if (field.type === 'number') return asNumber(value) ?? ''
  return value == null ? '' : String(value)
}

function FormFieldInput({
  field,
  value,
  path,
  errors,
  disabled,
  onChange,
}: {
  field: ModuleFormField
  value: FieldValue | undefined
  path: string
  errors: Record<string, string>
  disabled: boolean
  onChange: (next: FieldValue) => void
}) {
  const error = errors[path]
  const options = usableOptions(field)

  if (field.type === 'array') {
    const items = asFieldRecords(value)
    const named = field.fields.filter((child) => child.name)
    return (
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {field.label}
          {field.required ? ' *' : ''}
        </Text>
        {named.length === 0 ? (
          <Text size="xs" c="dimmed">
            This array has no item fields yet.
          </Text>
        ) : (
          items.map((item, index) => (
            <Stack key={`${path}.${index}`} gap="xs" className="field-editor">
              <Group justify="space-between">
                <Text size="xs" className="section-label">
                  {field.label || 'Item'} {index + 1}
                </Text>
                <Button
                  type="button"
                  size="compact-xs"
                  color="red"
                  variant="light"
                  disabled={disabled}
                  onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Remove
                </Button>
              </Group>
              {named.map((child, childIndex) => (
                <FormFieldInput
                  key={childIndex}
                  field={child}
                  value={item[child.name]}
                  path={`${path}.${index}.${child.name}`}
                  errors={errors}
                  disabled={disabled}
                  onChange={(next) => onChange(items.map((current, itemIndex) => (itemIndex === index ? { ...current, [child.name]: next } : current)))}
                />
              ))}
            </Stack>
          ))
        )}
        {error ? (
          <Text size="xs" c="red">
            {error}
          </Text>
        ) : null}
        <Button
          type="button"
          variant="default"
          size="compact-sm"
          disabled={disabled || named.length === 0}
          onClick={() => onChange([...items, valuesFrom({}, named, false)])}
        >
          Add {field.label || 'item'}
        </Button>
      </Stack>
    )
  }

  if (field.type === 'checkbox' && field.options.length > 0) {
    const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    return (
      <Checkbox.Group
        label={field.label}
        description={field.placeholder || undefined}
        withAsterisk={field.required}
        value={selected}
        error={error}
        onChange={onChange}
      >
        <Stack gap={6} mt={4}>
          {options.map((option, index) => (
            <Checkbox key={`${option}:${index}`} value={option} label={option} disabled={disabled} />
          ))}
        </Stack>
      </Checkbox.Group>
    )
  }

  if (field.type === 'checkbox') {
    return (
      <Checkbox
        label={field.label}
        description={field.placeholder || undefined}
        checked={value === true}
        disabled={disabled}
        error={error}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    )
  }

  if (field.type === 'radio') {
    return (
      <Radio.Group
        label={field.label}
        description={field.placeholder || undefined}
        withAsterisk={field.required}
        value={typeof value === 'string' && value ? value : null}
        error={error}
        onChange={onChange}
      >
        <Stack gap={6} mt={4}>
          {options.length === 0 ? (
            <Text size="xs" c="dimmed">
              Add options in the field builder.
            </Text>
          ) : (
            options.map((option, index) => <Radio key={`${option}:${index}`} value={option} label={option} disabled={disabled} />)
          )}
        </Stack>
      </Radio.Group>
    )
  }

  if (field.type === 'textarea') {
    return (
      <Textarea
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        minRows={2}
        autosize
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        error={error}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    )
  }

  if (field.type === 'number') {
    return (
      <NumberInput
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        disabled={disabled}
        error={error}
        onChange={onChange}
      />
    )
  }

  if (field.type === 'select') {
    return (
      <Select
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        data={options}
        value={typeof value === 'string' && value ? value : null}
        disabled={disabled}
        error={error}
        allowDeselect={!field.required}
        onChange={(next) => onChange(next ?? '')}
      />
    )
  }

  return (
    <TextInput
      label={field.label}
      placeholder={field.placeholder || undefined}
      withAsterisk={field.required}
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      error={error}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  )
}

function modulePages(fields: ModuleFormField[]) {
  const indexes = [...new Set(fields.map((field) => field.page ?? 0))].sort((left, right) => left - right)
  if (indexes.length === 0) return [fields]
  return indexes.map((page) => fields.filter((field) => (field.page ?? 0) === page))
}

export function FormModule({ data, config, onAction, acting, sequenceRun }: ModuleViewProps) {
  const parsed = parseModuleFormFields(config.fields)
  const fields = parsed.fields.filter((field) => field.name)
  const pages = modulePages(fields)
  const remote = valuesFrom(data, fields)
  const [draft, setDraft] = useState<{ schema: unknown; values: FieldRecord } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pageCursor, setPageCursor] = useState(0)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [pauseFields, setPauseFields] = useState<ModuleFormField[] | null>(null)
  const carried = useRef<FieldRecord>({})
  const kept = draft != null && draft.schema === config.fields && !sameValue(draft.values, remote) ? draft : null
  if (draft != null && kept == null) setDraft(null)
  const values = kept ? kept.values : remote
  const visible = pauseFields ?? pages[Math.min(pageCursor, Math.max(pages.length - 1, 0))] ?? []
  const laterPage = !pauseFields && pageCursor < pages.length - 1

  useEffect(() => {
    setPageCursor(0)
    setResumeId(null)
    setPauseFields(null)
    carried.current = {}
  }, [config.fields])

  const setField = (name: string, next: FieldValue) => {
    setDraft((current) => {
      const base = current && current.schema === config.fields ? current.values : remote
      return { schema: config.fields, values: { ...base, [name]: next } }
    })
    setErrors((current) => {
      const prefix = `${name}.`
      const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== name && !key.startsWith(prefix)))
      return rest
    })
  }

  const submit = async () => {
    const nextErrors = collectErrors(visible, values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    const pagePayload = postedRecord(visible, values)
    if (!sequenceRun) {
      if (laterPage) {
        setPageCursor((current) => current + 1)
        return
      }
      const ok = await onAction(postedRecord(fields, values))
      if (ok) setPageCursor(0)
      return
    }
    try {
      const outcome = await sequenceRun({ ...carried.current, ...pagePayload }, resumeId ?? undefined)
      if (outcome.status === 'pending') {
        carried.current = { ...carried.current, ...pagePayload }
        setResumeId(outcome.stateId)
        const decision = nextFormPage({
          plannedNames: pages.map((page) => page.map((field) => field.name)),
          cursor: pageCursor,
          pendingNames: outcome.parameters.map((parameter) => parameter.name).filter(Boolean),
        })
        if (decision.usePending) {
          setPauseFields(moduleFormFieldsFromWebhookParameters(outcome.parameters))
        } else if (decision.cursor === pageCursor) {
          notifications.show({
            color: 'yellow',
            title: 'Still needs input',
            message: 'Fill the required fields to continue.',
          })
        } else {
          setPauseFields(null)
          setPageCursor(decision.cursor)
        }
        return
      }
      carried.current = {}
      setResumeId(null)
      setPauseFields(null)
      setPageCursor(0)
      setDraft(null)
    } catch {
      // sequenceRun reports the failure.
    }
  }

  if (parsed.error) return <ShapeNote expected={parsed.error} />
  if (fields.length === 0 && !pauseFields) {
    if (!sequenceRun) return <ShapeNote expected={formShape} />
    return (
      <Button loading={acting} onClick={() => void submit()}>
        Submit
      </Button>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Stack gap="xs">
        {pages.length > 1 && !pauseFields ? (
          <Text size="xs" c="dimmed">
            Page {pageCursor + 1} of {pages.length}
          </Text>
        ) : null}
        {pauseFields ? (
          <Text size="xs" c="dimmed">
            This sequence needs more input before it can finish.
          </Text>
        ) : null}
        {visible.map((field, index) => (
          <FormFieldInput
            key={`${field.name}:${index}`}
            field={field}
            value={values[field.name]}
            path={field.name}
            errors={errors}
            disabled={acting}
            onChange={(next) => setField(field.name, next)}
          />
        ))}
        <Button type="submit" loading={acting}>
          {pauseFields ? 'Continue' : laterPage ? 'Next' : 'Submit'}
        </Button>
      </Stack>
    </form>
  )
}
