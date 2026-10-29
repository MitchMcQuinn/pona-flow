import { useEffect, useState } from 'react'
import { Button, Group, NumberInput, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core'
import {
  emptyModuleFormField,
  parseModuleFormFields,
  serializeModuleFormFields,
  moduleFormFieldTypes,
  type ModuleFormField,
  type ModuleFormFieldType,
} from '../modules/formFields'

const typeOptions = moduleFormFieldTypes.map((type) => ({ value: type, label: type }))

type FieldListEditorProps = {
  label: string
  description?: string
  value: string
  onChange: (value: string) => void
}

export function FieldListEditor({ label, description, value, onChange }: FieldListEditorProps) {
  const parsed = parseModuleFormFields(value)
  const [mode, setMode] = useState<'builder' | 'json'>(parsed.error ? 'json' : 'builder')
  const [jsonDraft, setJsonDraft] = useState(value)
  const jsonError = mode === 'json' ? parseModuleFormFields(jsonDraft).error : null

  useEffect(() => {
    setJsonDraft(value)
  }, [value])

  const updateFields = (fields: ModuleFormField[]) => {
    onChange(serializeModuleFormFields(fields))
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {description ? (
            <Text size="xs" c="dimmed">
              {description}
            </Text>
          ) : null}
        </div>
        <SegmentedControl
          size="xs"
          value={mode}
          data={[
            { value: 'builder', label: 'Builder' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={(next) => {
            if (next === 'json') {
              setJsonDraft(value)
              setMode('json')
              return
            }
            if (parseModuleFormFields(jsonDraft).error) return
            onChange(jsonDraft)
            setMode('builder')
          }}
        />
      </Group>

      {mode === 'json' ? (
        <Textarea
          minRows={8}
          autosize
          value={jsonDraft}
          error={jsonError}
          onChange={(event) => {
            const next = event.currentTarget.value
            setJsonDraft(next)
            if (!parseModuleFormFields(next).error) onChange(next)
          }}
        />
      ) : (
        <FieldRows fields={parsed.fields} onChange={updateFields} />
      )}
    </Stack>
  )
}

function FieldRows({ fields, onChange }: { fields: ModuleFormField[]; onChange: (fields: ModuleFormField[]) => void }) {
  const repeated = duplicateNames(fields)
  const updateAt = (index: number, field: ModuleFormField) => onChange(replace(fields, index, field))

  return (
    <Stack gap="sm">
      {fields.map((field, index) => (
        <Stack key={index} gap="xs" className="field-editor">
          {fields.some((item) => (item.page ?? 0) > 0) ? (
            <Text size="xs" c="dimmed">
              Page {(field.page ?? 0) + 1}
            </Text>
          ) : null}
          <TextInput
            label="Label"
            value={field.label}
            onChange={(event) => updateAt(index, { ...field, label: event.currentTarget.value })}
          />
          <TextInput
            label="Name"
            description="Key in the posted JSON."
            value={field.name}
            onChange={(event) =>
              updateAt(index, { ...field, name: event.currentTarget.value.replace(/[^a-zA-Z0-9_]/g, '') })
            }
          />
          <Select
            label="Type"
            data={typeOptions}
            value={field.type}
            allowDeselect={false}
            onChange={(next) => {
              if (!isFieldType(next)) return
              updateAt(index, { ...field, type: next })
            }}
          />
          {field.type === 'number' ? (
            <Group grow>
              <NumberInput
                label="Min"
                value={field.min ?? ''}
                onChange={(next) => updateAt(index, { ...field, min: optionalNumber(next) })}
              />
              <NumberInput
                label="Max"
                value={field.max ?? ''}
                onChange={(next) => updateAt(index, { ...field, max: optionalNumber(next) })}
              />
            </Group>
          ) : null}
          {field.type === 'number' && field.min != null && field.max != null && field.min > field.max ? (
            <Text size="xs" c="red">
              Min is greater than max.
            </Text>
          ) : null}
          {field.type === 'select' || field.type === 'checkbox' || field.type === 'radio' ? (
            <OptionsEditor options={field.options} onChange={(options) => updateAt(index, { ...field, options })} />
          ) : null}
          {field.type === 'array' ? (
            <Stack gap="xs">
              <Text className="section-label">Item fields</Text>
              <Text size="xs" c="dimmed">
                Each entry in the array uses these fields. An item field can itself be an array.
              </Text>
              <FieldRows fields={field.fields} onChange={(nested) => updateAt(index, { ...field, fields: nested })} />
            </Stack>
          ) : (
            <TextInput
              label="Placeholder"
              value={field.placeholder}
              onChange={(event) => updateAt(index, { ...field, placeholder: event.currentTarget.value })}
            />
          )}
          <Group justify="space-between">
            <Switch
              label="Required"
              checked={field.required}
              onChange={(event) => updateAt(index, { ...field, required: event.currentTarget.checked })}
            />
            <Group gap="xs">
              <Button size="compact-xs" variant="default" disabled={index === 0} onClick={() => onChange(move(fields, index, -1))}>
                Up
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                disabled={index === fields.length - 1}
                onClick={() => onChange(move(fields, index, 1))}
              >
                Down
              </Button>
              <Button
                size="compact-xs"
                color="red"
                variant="light"
                onClick={() => onChange(fields.filter((_, fieldIndex) => fieldIndex !== index))}
              >
                Remove
              </Button>
            </Group>
          </Group>
        </Stack>
      ))}
      {repeated.length > 0 ? (
        <Text size="xs" c="red">
          Field names must be unique. Repeated: {repeated.join(', ')}.
        </Text>
      ) : null}
      <Button variant="default" onClick={() => onChange([...fields, emptyModuleFormField(fields.length + 1)])}>
        Add field
      </Button>
    </Stack>
  )
}

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (options: string[]) => void }) {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Options
      </Text>
      {options.map((option, index) => (
        <Group key={index} gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            aria-label={`Option ${index + 1}`}
            value={option}
            onChange={(event) => onChange(options.map((current, optionIndex) => (optionIndex === index ? event.currentTarget.value : current)))}
          />
          <Button size="compact-xs" variant="default" onClick={() => onChange(options.filter((_, optionIndex) => optionIndex !== index))}>
            Remove
          </Button>
        </Group>
      ))}
      <Button size="compact-sm" variant="default" onClick={() => onChange([...options, ''])}>
        Add option
      </Button>
    </Stack>
  )
}

function optionalNumber(value: string | number) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function duplicateNames(fields: ModuleFormField[]) {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const field of fields) {
    if (!field.name) continue
    if (seen.has(field.name)) repeated.add(field.name)
    seen.add(field.name)
  }
  return [...repeated]
}

function replace(fields: ModuleFormField[], index: number, field: ModuleFormField) {
  return fields.map((current, fieldIndex) => (fieldIndex === index ? field : current))
}

function move(fields: ModuleFormField[], index: number, direction: -1 | 1) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= fields.length) return fields
  const next = [...fields]
  const [field] = next.splice(index, 1)
  if (!field) return fields
  next.splice(nextIndex, 0, field)
  return next
}

function isFieldType(value: string | null): value is ModuleFormFieldType {
  return value != null && (moduleFormFieldTypes as readonly string[]).includes(value)
}
