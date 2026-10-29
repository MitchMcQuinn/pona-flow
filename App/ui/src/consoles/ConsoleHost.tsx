import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { FormViewPanel } from './components/FormViewPanel'
import { LiveViewCanvas } from './components/LiveViewCanvas'
import { ViewBar } from './components/ViewBar'
import { ViewSettings } from './components/ViewSettings'
import { AddModuleModal } from './components/AddModuleModal'
import { ConsoleFrame } from './ConsoleFrame'
import { addModule, addView, hydrateConsole, rebindModules, setActiveView, updateConsole, useConsoleRecord } from './docStore'
import { useConsoleRefresh } from './hooks/useConsoleRefresh'
import { createModuleInstance } from './modules/create'
import { bindModuleSequences, consoleFromApi, documentFromRecord } from './normalize'
import { SequenceOptionsProvider } from './sequenceOptions'
import type { TriggerKind } from './types'
import { fetchConsole, saveConsole, type ConsoleDetail } from '../services/api'
import type { EventSummary, SequenceSummary } from '../state/types'

type ConsoleHostProps = {
  spaceId: string
  consoleId: string
  mode: 'edit' | 'live'
  /** Bumps when the nav edit icon should open this console in edit mode. */
  editNonce?: number
  onEditingChange?: (editing: boolean) => void
  /** Nav label. Called with the name that will be saved, including the "Console" fallback. */
  onRenamed?: (name: string) => void
  sequences: SequenceSummary[]
  events: EventSummary[]
  externalRefreshToken: number
  /**
   * Simulation session view. Advance tic is the refresh trigger: the listen
   * URL and trigger event stay disconnected.
   */
  driven?: boolean
  /** Fit the live grid to its container instead of a fixed canvas width. */
  fluid?: boolean
}

export function ConsoleHost(props: ConsoleHostProps) {
  return (
    <ConsoleFrame className={props.fluid ? 'consoleEmbedded' : undefined}>
      <ConsoleEditor {...props} />
    </ConsoleFrame>
  )
}

function ConsoleEditor({
  spaceId,
  consoleId,
  mode,
  editNonce = 0,
  onEditingChange,
  onRenamed,
  sequences,
  events,
  externalRefreshToken,
  driven = false,
  fluid,
}: ConsoleHostProps) {
  const record = useConsoleRecord()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(() => editNonce > 0)
  const appliedEdit = useRef<number | null>(null)
  const seenConsoleId = useRef<string | null>(null)
  const [viewName, setViewName] = useState('')
  const [viewKind, setViewKind] = useState<'live' | 'form'>('live')
  const [triggerTab, setTriggerTab] = useState<'url' | 'event'>('url')
  const [addViewOpened, { open: openAddView, close: closeAddView }] = useDisclosure(false)
  const [viewSettingsOpened, { open: openViewSettings, close: closeViewSettings }] = useDisclosure(false)
  const [addOpened, { open: openAdd, close: closeAdd }] = useDisclosure(false)
  const canEdit = mode === 'edit'
  const reportEditing = canEdit && editing
  useEffect(() => {
    onEditingChange?.(reportEditing)
    return () => onEditingChange?.(false)
  }, [reportEditing, onEditingChange])
  const active = record && record.id === consoleId
    ? record.views.find((view) => view.id === record.activeViewId) ?? record.views[0]
    : undefined
  const simulationDriven = driven || mode === 'live'
  const owned = record && record.id === consoleId ? record : null
  const { token, refreshNow } = useConsoleRefresh({
    driven: simulationDriven,
    triggerKind: !simulationDriven && owned ? owned.triggerKind : '',
    listenUrl: !simulationDriven && owned ? owned.listenUrl : '',
    consoleId,
    externalToken: externalRefreshToken,
  })

  useEffect(() => {
    if (!record || record.id !== consoleId) return
    setTriggerTab(record.triggerKind === 'event' ? 'event' : 'url')
  }, [consoleId, record?.id])

  useEffect(() => {
    if (appliedEdit.current !== editNonce) {
      appliedEdit.current = editNonce
      seenConsoleId.current = consoleId
      setEditing(editNonce > 0)
      return
    }
    if (seenConsoleId.current !== consoleId) {
      seenConsoleId.current = consoleId
      setEditing(false)
    }
  }, [consoleId, editNonce])

  useEffect(() => {
    if (!record || record.id !== consoleId || sequences.length === 0) return
    rebindModules((module) => bindModuleSequences(module, sequences))
  }, [consoleId, record, sequences])

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    hydrateConsole(null)
    fetchConsole(consoleId)
      .then((row) => {
        if (!cancelled) hydrateConsole(consoleFromApi(row))
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : 'Unable to load console')
      })
    return () => {
      cancelled = true
    }
  }, [consoleId])

  const savedName = record && record.id === consoleId ? record.name.trim() || 'Console' : null
  useEffect(() => {
    if (savedName == null) return
    onRenamed?.(savedName)
  }, [savedName, onRenamed])

  useEffect(() => {
    if (mode !== 'edit' || !record || record.id !== consoleId) return
    const handle = window.setTimeout(() => {
      const payload: ConsoleDetail = {
        id: record.id,
        spaceId,
        name: record.name.trim() || 'Console',
        triggerKind: record.triggerKind,
        listenUrl: record.listenUrl,
        triggerEventId: record.triggerEventId,
        document: documentFromRecord(record),
      }
      saveConsole(payload).catch(() => undefined)
    }, 400)
    return () => window.clearTimeout(handle)
  }, [consoleId, mode, record, spaceId])

  const sequenceOptions = sequences
    .filter((sequence) => sequence.kind === 'sequence' || sequence.kind === 'operation')
    .map((sequence) => ({ value: sequence.id, label: sequence.label }))
  const triggerEvents = events.filter((event) => event.id && (event.type === 'time' || event.type === 'external'))
  const triggerEventOptions = (['time', 'external'] as const)
    .map((type) => ({
      group: type,
      items: triggerEvents
        .filter((event) => event.type === type)
        .map((event) => ({ value: event.id, label: event.name || event.id })),
    }))
    .filter((group) => group.items.length > 0)

  if (loadError) {
    return <Text c="red">{loadError}</Text>
  }
  if (!record || record.id !== consoleId || !active) {
    return <Text c="dimmed">Loading console...</Text>
  }

  const shownEditing = canEdit && editing

  return (
    <SequenceOptionsProvider options={sequenceOptions}>
      <Stack gap="md" className="consoleEditor">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Title order={2}>{record.name}</Title>
          <Group gap={8} align="center" wrap="wrap">
            {shownEditing ? null : (
              <BarIcon label="Refresh" onClick={refreshNow}>
                <RefreshIcon />
              </BarIcon>
            )}
            {canEdit && shownEditing ? (
              <button type="button" className="panelTextButton" onClick={() => setEditing(false)}>
                done editing
              </button>
            ) : canEdit ? (
              <BarIcon label="Edit" onClick={() => setEditing(true)}>
                <EditIcon />
              </BarIcon>
            ) : null}
            {shownEditing && active.kind === 'live' ? (
              <button type="button" className="panelTextButton" onClick={openAdd}>
                Add module
              </button>
            ) : null}
          </Group>
        </Group>

        {shownEditing ? (
          <Stack className="consoleEditSettings" gap="sm">
            <TextInput
              label="Name"
              value={record.name}
              onChange={(event) => updateConsole({ name: event.currentTarget.value })}
            />
            <SegmentedControl
              fullWidth
              value={triggerTab}
              data={[
                { value: 'url', label: 'Listen URL' },
                { value: 'event', label: 'Event' },
              ]}
              onChange={(value) => {
                const next = value === 'event' ? 'event' : 'url'
                setTriggerTab(next)
                if (next === 'url') {
                  updateConsole({ triggerKind: 'url', triggerEventId: '' })
                }
              }}
            />
            {triggerTab === 'url' ? (
              <TextInput
                label="Listen URL"
                description="Server-Sent Events stream. A refresh event, or a plain message, refetches the console."
                placeholder="https://example.com/events"
                value={record.listenUrl}
                onChange={(event) =>
                  updateConsole({ triggerKind: 'url', listenUrl: event.currentTarget.value, triggerEventId: '' })
                }
              />
            ) : (
              <Select
                label="Trigger event"
                description="A time or external event. Each fire refreshes this console."
                placeholder="Search events"
                data={triggerEventOptions}
                value={record.triggerEventId || null}
                searchable
                allowDeselect={false}
                nothingFoundMessage={
                  triggerEvents.length === 0 ? 'No time or external events' : 'No matching events'
                }
                maxDropdownHeight={280}
                comboboxProps={{
                  withinPortal: false,
                  hideDetached: false,
                  width: 'target',
                  zIndex: 1200,
                }}
                filter={({ options, search, limit }) => {
                  const term = search.trim().toLowerCase()
                  const matched = []
                  for (const item of options) {
                    if (matched.length >= limit) break
                    if (!('items' in item)) continue
                    const items = item.items.filter((option) => {
                      const event = triggerEvents.find((candidate) => candidate.id === option.value)
                      return `${option.label} ${event?.type ?? ''}`.toLowerCase().includes(term)
                    })
                    if (items.length > 0) matched.push({ group: item.group, items })
                  }
                  return matched
                }}
                renderOption={({ option }) => {
                  const event = triggerEvents.find((item) => item.id === option.value)
                  return (
                    <Group justify="space-between" gap="sm" wrap="nowrap">
                      <Text size="sm" truncate="end">
                        {option.label}
                      </Text>
                      {event ? (
                        <Text size="xs" c="dimmed">
                          {event.type}
                        </Text>
                      ) : null}
                    </Group>
                  )
                }}
                onChange={(value) => {
                  if (!value) return
                  updateConsole({ triggerKind: 'event' satisfies TriggerKind, triggerEventId: value, listenUrl: '' })
                }}
              />
            )}
          </Stack>
        ) : null}

        <ViewBar
          dashboard={record}
          editing={shownEditing}
          configuring={viewSettingsOpened}
          onAdd={() => {
            setViewName('')
            setViewKind('live')
            openAddView()
          }}
          onConfigure={openViewSettings}
        />

        {active.kind === 'live' ? (
          <LiveViewCanvas
            key={active.id}
            spaceId={spaceId}
            dashboardId={record.id}
            view={active}
            editing={shownEditing}
            refreshToken={token}
            onConsoleRefresh={refreshNow}
            fluid={fluid}
            onAddRequest={() => {
              setEditing(true)
              openAdd()
            }}
          />
        ) : (
          <FormViewPanel key={active.id} dashboardId={record.id} view={active} refreshToken={token} />
        )}

        <ViewSettings
          spaceId={spaceId}
          view={active}
          canDelete={record.views.length > 1}
          opened={viewSettingsOpened && canEdit}
          onClose={closeViewSettings}
        />

        <Modal opened={addViewOpened} onClose={closeAddView} title="Add view">
          <Stack>
            <TextInput
              label="Name"
              value={viewName}
              placeholder={viewKind === 'form' ? 'Form' : 'Live'}
              onChange={(event) => setViewName(event.currentTarget.value)}
            />
            <SegmentedControl
              fullWidth
              value={viewKind}
              data={[
                { value: 'live', label: 'Live' },
                { value: 'form', label: 'Form' },
              ]}
              onChange={(value) => setViewKind(value === 'form' ? 'form' : 'live')}
            />
            <Button
              onClick={() => {
                const view = addView(viewKind, viewName.trim())
                if (view) setActiveView(view.id)
                closeAddView()
              }}
            >
              Create view
            </Button>
          </Stack>
        </Modal>

        <AddModuleModal
          opened={addOpened && active.kind === 'live'}
          onClose={closeAdd}
          onAdd={(type) => {
            if (active.kind !== 'live') return
            const y = active.modules.reduce((max, module) => Math.max(max, module.layout.y + module.layout.h), 0)
            const module = createModuleInstance(type, { x: 0, y })
            if (module) addModule(active.id, module)
          }}
        />
      </Stack>
    </SequenceOptionsProvider>
  )
}

function BarIcon({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <UnstyledButton
      className="bar-icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-active={pressed ? 'true' : undefined}
      onClick={onClick}
    >
      {children}
    </UnstyledButton>
  )
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

function RefreshIcon() {
  return (
    <svg {...iconProps}>
      <path d="M21 12a9 9 0 1 1-2.2-5.8" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.4-9.4z" />
    </svg>
  )
}

