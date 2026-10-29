import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Group, NumberInput, Paper, Select, Stack, Text, Textarea, TextInput } from '@mantine/core'
import { useForm, type UseFormReturnType } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { runConsoleSequence, runConsoleSequenceOutcome } from '../../services/api'
import { isRecord } from '../modules/data'
import type { FormDashboardView, FormFieldDefinition } from '../types'
import { formFieldsFromWebhookParameters, nextFormPage } from '../webhookFields'

type FormValue = string | number | boolean | string[]
type FormValues = Record<string, FormValue>

function optionList(options: string) {
  return options
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)
}

function isMultiCheckbox(field: FormFieldDefinition) {
  return field.type === 'checkbox' && optionList(field.options).length > 0
}

function choiceValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean)
  } catch {
    // A comma-separated list is the other shape a data sequence may return.
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function emptyValue(field: FormFieldDefinition): FormValue {
  if (isMultiCheckbox(field)) return []
  return field.type === 'checkbox' ? false : ''
}

function valuesFromPayload(fields: FormFieldDefinition[], data: unknown): FormValues {
  const source = isRecord(data) && isRecord(data.values) ? data.values : isRecord(data) ? data : {}
  const values: FormValues = {}
  for (const field of fields) {
    const raw = source[field.name]
    if (isMultiCheckbox(field)) {
      values[field.id] = choiceValue(raw)
    } else if (field.type === 'checkbox') {
      values[field.id] = raw === true || raw === 'true'
    } else if (field.type === 'number') {
      values[field.id] = typeof raw === 'number' ? raw : raw == null || raw === '' ? '' : Number(raw)
    } else {
      values[field.id] = raw == null ? '' : String(raw)
    }
  }
  return values
}

function initialValues(fields: FormFieldDefinition[]): FormValues {
  const values: FormValues = {}
  for (const field of fields) values[field.id] = emptyValue(field)
  return values
}

function formPages(fields: FormFieldDefinition[]) {
  const indexes = [...new Set(fields.map((field) => field.page))].sort((left, right) => left - right)
  if (indexes.length === 0) return [fields]
  return indexes.map((page) => fields.filter((field) => field.page === page))
}

function answeredValues(fields: FormFieldDefinition[], values: FormValues) {
  const payload: Record<string, FormValue> = {}
  for (const field of fields) {
    if (!field.name) continue
    const value = values[field.id] ?? emptyValue(field)
    if (value === '' || value == null) continue
    if (Array.isArray(value) && value.length === 0) continue
    payload[field.name] = value
  }
  return payload
}

function sameValue(left: FormValue | undefined, right: FormValue | undefined) {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right)
  return left === right
}

function useFormSequenceData(consoleId: string, viewId: string, sequenceId: string, refreshToken: number) {
  const [state, setState] = useState<{
    token: number
    sequenceId: string
    data: unknown
    error: string | null
    loading: boolean
  }>({ token: -1, sequenceId: '', data: null, error: null, loading: false })

  useEffect(() => {
    if (!sequenceId) {
      setState({ token: refreshToken, sequenceId, data: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setState((current) => ({ ...current, loading: true, error: null }))
    runConsoleSequence({
      consoleId,
      sequenceId,
      viewId,
      role: 'data',
      params: { console_id: consoleId, view_id: viewId },
    })
      .then((result) => {
        if (cancelled) return
        setState({ token: refreshToken, sequenceId, data: result, error: null, loading: false })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setState({
          token: refreshToken,
          sequenceId,
          data: null,
          error: reason instanceof Error ? reason.message : 'Request failed',
          loading: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [consoleId, viewId, sequenceId, refreshToken])

  const current = state.sequenceId === sequenceId && state.token === refreshToken
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: sequenceId ? !current || state.loading : false,
  }
}

type FormViewPanelProps = {
  dashboardId: string
  view: FormDashboardView
  refreshToken: number
}

export function FormViewPanel({ dashboardId, view, refreshToken }: FormViewPanelProps) {
  const sequence = useFormSequenceData(dashboardId, view.id, view.dataSequenceId, refreshToken)
  const signature = view.fields
    .map((field) => `${field.id}:${field.name}:${field.type}:${field.required ? 1 : 0}:${field.options}:${field.page}`)
    .join('|')
  return (
    <FormViewBody
      key={signature}
      dashboardId={dashboardId}
      view={view}
      data={sequence.data}
      loading={sequence.loading}
      error={sequence.error}
    />
  )
}

function FormViewBody({
  dashboardId,
  view,
  data,
  loading,
  error,
}: {
  dashboardId: string
  view: FormDashboardView
  data: unknown
  loading: boolean
  error: string | null
}) {
  const [acting, setActing] = useState(false)
  const [pageCursor, setPageCursor] = useState(0)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [pauseFields, setPauseFields] = useState<FormFieldDefinition[] | null>(null)
  const carried = useRef<Record<string, FormValue>>({})
  const fieldsRef = useRef(view.fields)
  const plannedPages = formPages(view.fields)
  const visible = pauseFields ?? plannedPages[Math.min(pageCursor, Math.max(plannedPages.length - 1, 0))] ?? []
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const laterPage = !pauseFields && pageCursor < plannedPages.length - 1

  useEffect(() => {
    fieldsRef.current = view.fields
  })

  const form = useForm<FormValues>({
    mode: 'controlled',
    initialValues: initialValues(view.fields),
    validateInputOnBlur: true,
    validate: (values) => {
      const errors: Record<string, string> = {}
      for (const field of visibleRef.current) {
        if (!field.required) continue
        const value = values[field.id]
        const missing = isMultiCheckbox(field)
          ? !Array.isArray(value) || value.length === 0
          : field.type === 'checkbox'
            ? value !== true
            : value === '' || value == null || (typeof value === 'number' && Number.isNaN(value))
        if (missing) errors[field.id] = 'Required'
      }
      return errors
    },
  })

  useEffect(() => {
    if (data == null || form.isDirty()) return
    const next = valuesFromPayload(fieldsRef.current, data)
    const current = form.getValues()
    const same = fieldsRef.current.every((field) => sameValue(current[field.id], next[field.id]))
    if (same) return
    form.setValues(next)
    form.resetDirty(next)
  }, [data, form])

  const submit = async (values: FormValues) => {
    if (!view.actionSequenceId) {
      notifications.show({ color: 'yellow', title: 'No action sequence', message: 'Choose an action sequence before submitting.' })
      return
    }
    const pagePayload = answeredValues(visibleRef.current, values)
    const payload: Record<string, FormValue> = {
      console_id: dashboardId,
      view_id: view.id,
      ...carried.current,
      ...pagePayload,
    }
    setActing(true)
    try {
      const outcome = await runConsoleSequenceOutcome({
        consoleId: dashboardId,
        sequenceId: view.actionSequenceId,
        viewId: view.id,
        role: 'action',
        params: payload,
        stateId: resumeId ?? undefined,
      })
      if (outcome.status === 'pending') {
        carried.current = { ...carried.current, ...pagePayload }
        setResumeId(outcome.state_id)
        const decision = nextFormPage({
          plannedNames: plannedPages.map((page) => page.map((field) => field.name)),
          cursor: pageCursor,
          pendingNames: outcome.parameters.map((parameter) => parameter.name),
        })
        if (decision.usePending) {
          const asked = formFieldsFromWebhookParameters(outcome.parameters, () => crypto.randomUUID())
          for (const field of asked) form.setFieldValue(field.id, emptyValue(field))
          setPauseFields(asked)
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
        form.resetDirty()
        return
      }
      carried.current = {}
      setResumeId(null)
      setPauseFields(null)
      setPageCursor(0)
      form.resetDirty()
      notifications.show({ color: 'teal', title: 'Submitted', message: view.name })
    } catch (reason) {
      notifications.show({
        color: 'red',
        title: 'Post failed',
        message: reason instanceof Error ? reason.message : 'Request failed',
      })
    } finally {
      setActing(false)
    }
  }

  return (
    <Paper className="surface-card" withBorder p="lg" maw={560}>
      <form onSubmit={form.onSubmit((values) => void submit(values))}>
        <Stack gap="sm">
          <Text className="section-label">form</Text>
          {loading && data == null ? (
            <Text size="sm" c="dimmed">
              Loading form data
            </Text>
          ) : null}
          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : null}
          {plannedPages.length > 1 && !pauseFields ? (
            <Text size="sm" c="dimmed">
              Page {pageCursor + 1} of {plannedPages.length}
            </Text>
          ) : null}
          {pauseFields ? (
            <Text size="sm" c="dimmed">
              This sequence needs more input before it can finish.
            </Text>
          ) : null}
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed">
              This form has no fields yet. Add some from view settings.
            </Text>
          ) : (
            visible.map((field) => <FormControl key={field.id} field={field} getInputProps={form.getInputProps} />)
          )}
          <Group justify="space-between">
            <Button type="submit" loading={acting} disabled={visible.length === 0 && !pauseFields}>
              {pauseFields ? 'Continue' : laterPage ? 'Next' : view.submitLabel || 'Submit'}
            </Button>
            {form.isDirty() && view.dataSequenceId ? (
              <Button
                variant="subtle"
                onClick={() => {
                  const next = valuesFromPayload(view.fields, data)
                  form.setValues(next)
                  form.resetDirty(next)
                }}
              >
                Load latest
              </Button>
            ) : null}
          </Group>
        </Stack>
      </form>
    </Paper>
  )
}

function FormControl({
  field,
  getInputProps,
}: {
  field: FormFieldDefinition
  getInputProps: UseFormReturnType<FormValues>['getInputProps']
}) {
  if (isMultiCheckbox(field)) {
    const input = getInputProps(field.id)
    const selected = Array.isArray(input.value) ? input.value.filter((item): item is string => typeof item === 'string') : []
    return (
      <Checkbox.Group
        label={field.label}
        description={field.placeholder || undefined}
        withAsterisk={field.required}
        value={selected}
        error={input.error}
        onChange={(value) => input.onChange(value)}
      >
        <Stack gap={6} mt={4}>
          {optionList(field.options).map((option, index) => (
            <Checkbox key={`${option}:${index}`} value={option} label={option} />
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
        {...getInputProps(field.id, { type: 'checkbox' })}
      />
    )
  }
  if (field.type === 'textarea') {
    return (
      <Textarea
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        minRows={3}
        autosize
        {...getInputProps(field.id)}
      />
    )
  }
  if (field.type === 'number') {
    return (
      <NumberInput
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        {...getInputProps(field.id)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <Select
        label={field.label}
        placeholder={field.placeholder || undefined}
        withAsterisk={field.required}
        data={optionList(field.options)}
        allowDeselect={false}
        {...getInputProps(field.id)}
      />
    )
  }
  return (
    <TextInput
      label={field.label}
      placeholder={field.placeholder || undefined}
      withAsterisk={field.required}
      {...getInputProps(field.id)}
    />
  )
}
