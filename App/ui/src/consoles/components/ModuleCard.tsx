import { Component, memo, useState, type ReactNode } from 'react'
import { Alert, Box, Group, Loader, Paper, Skeleton, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { runConsoleSequence, runConsoleSequenceOutcome, type ConsoleSequenceOutcome } from '../../services/api'
import { useModuleData } from '../hooks/useModuleData'
import { postModuleAction } from '../hooks/postModuleAction'
import { actionSequenceParams, configString, pickPath } from '../modules/data'
import { getModuleDefinition } from '../modules/registry'
import type { ModuleInstance } from '../types'
import type { SequenceRunStep } from '../modules/types'

type ModuleCardProps = {
  dashboardId: string
  viewId: string
  module: ModuleInstance
  refreshToken: number
  onConsoleRefresh: () => void
  editing: boolean
  selected: boolean
  onSelect: (id: string) => void
}

export const ModuleCard = memo(function ModuleCard({
  dashboardId,
  viewId,
  module,
  refreshToken,
  onConsoleRefresh,
  editing,
  selected,
  onSelect,
}: ModuleCardProps) {
  const definition = getModuleDefinition(module.type)
  const dataSequenceId = module.dataSequenceId.trim()
  const actionSequenceId = module.actionSequenceId.trim()
  const dataRepeatsAction =
    module.dataSource === 'sequence' &&
    module.actionSource === 'sequence' &&
    dataSequenceId !== '' &&
    dataSequenceId === actionSequenceId
  const { data, loading, error, refetch } = useModuleData(
    {
      kind: dataRepeatsAction ? 'url' : module.dataSource,
      dataUrl: dataRepeatsAction ? '' : module.dataUrl,
      sequenceId: dataRepeatsAction ? '' : module.dataSequenceId,
      consoleId: dashboardId,
      viewId,
      moduleId: module.id,
    },
    refreshToken,
  )
  const [acting, setActing] = useState(false)
  const View = definition?.View
  const picked = pickPath(data, configString(module.config, 'dataPath'))
  const dataReady = module.dataSource === 'sequence' ? Boolean(module.dataSequenceId.trim()) : Boolean(module.dataUrl.trim())
  const showEmpty = !dataReady && definition?.kind === 'display'

  const onAction = async (value: unknown) => {
    const useSequence = module.actionSource === 'sequence'
    if (useSequence && !module.actionSequenceId.trim()) {
      notifications.show({
        color: 'yellow',
        title: 'No action sequence',
        message: 'Choose an action sequence before posting a change.',
      })
      return false
    }
    if (!useSequence && !module.actionUrl.trim()) {
      notifications.show({
        color: 'yellow',
        title: 'No action URL',
        message: 'Set an action URL before posting a change.',
      })
      return false
    }
    setActing(true)
    try {
      if (useSequence) {
        await runConsoleSequence({
          consoleId: dashboardId,
          sequenceId: module.actionSequenceId.trim(),
          viewId,
          role: 'action',
          params: actionSequenceParams(value, {
            console_id: dashboardId,
            view_id: viewId,
            module_id: module.id,
            module_type: module.type,
          }),
        })
      } else {
        await postModuleAction({
          actionUrl: module.actionUrl,
          dashboardId,
          moduleId: module.id,
          moduleType: module.type,
          value,
        })
      }
      notifications.show({ color: 'teal', title: useSequence ? 'Ran' : 'Posted', message: module.title })
      refetch()
      return true
    } catch (reason) {
      notifications.show({
        color: 'red',
        title: 'Post failed',
        message: reason instanceof Error ? reason.message : 'Request failed',
      })
      return false
    } finally {
      setActing(false)
    }
  }

  const sequenceRun =
    module.type === 'form' && module.actionSource === 'sequence'
      ? async (params: Record<string, unknown>, stateId?: string): Promise<SequenceRunStep> => {
          if (!module.actionSequenceId.trim()) {
            notifications.show({
              color: 'yellow',
              title: 'No action sequence',
              message: 'Choose an action sequence before posting a change.',
            })
            throw new Error('no action sequence')
          }
          setActing(true)
          try {
            const outcome: ConsoleSequenceOutcome = await runConsoleSequenceOutcome({
              consoleId: dashboardId,
              sequenceId: module.actionSequenceId.trim(),
              viewId,
              role: 'action',
              stateId,
              params: actionSequenceParams(params, {
                console_id: dashboardId,
                view_id: viewId,
                module_id: module.id,
                module_type: module.type,
              }),
            })
            if (outcome.status === 'inactive') {
              notifications.show({ color: 'teal', title: 'Ran', message: module.title })
              if (module.config.autoRefresh !== false) onConsoleRefresh()
              else refetch()
              return { status: 'inactive' }
            }
            return { status: 'pending', stateId: outcome.state_id, parameters: outcome.parameters }
          } catch (reason) {
            notifications.show({
              color: 'red',
              title: 'Post failed',
              message: reason instanceof Error ? reason.message : 'Request failed',
            })
            throw reason
          } finally {
            setActing(false)
          }
        }
      : undefined

  return (
    <Paper
      className="module-frame"
      data-pin-target={module.id}
      data-selected={selected ? 'true' : 'false'}
      withBorder
      h="100%"
      onClick={() => {
        if (editing) onSelect(module.id)
      }}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Group
        className={editing ? 'module-drag-handle module-frame-header' : 'module-frame-header'}
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        px="sm"
        h={40}
        style={{ flex: 'none', cursor: editing ? 'grab' : 'default' }}
      >
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          {editing ? <GripIcon /> : null}
          <Text className="mono-label" size="sm" truncate>
            {module.title}
          </Text>
        </Group>
        {loading ? <Loader size="xs" color="accent" /> : null}
      </Group>
      <Box
        className="module-frame-body"
        data-fill={definition?.fill ? 'true' : 'false'}
        px="sm"
        py="sm"
        style={{ flex: 1, minHeight: 0, overflow: definition?.fill ? 'hidden' : 'auto' }}
      >
        {!definition || !View ? (
          <Text size="sm" c="dimmed">
            Unknown module type “{module.type}”.
          </Text>
        ) : loading && data == null ? (
          <Skeleton height="70%" mih={48} />
        ) : showEmpty ? (
          <Text size="sm" c="dimmed">
            {module.dataSource === 'sequence'
              ? 'Choose a data sequence for this module.'
              : 'Set a data URL for this module.'}
          </Text>
        ) : (
          <>
            {error ? (
              <Alert color="red" variant="light" p="xs" mb="xs">
                {error}
              </Alert>
            ) : null}
            {data != null || definition.kind === 'action' ? (
              <ModuleViewBoundary key={module.id}>
                <View
                  config={module.config}
                  data={picked}
                  acting={acting}
                  onAction={onAction}
                  sequenceRun={sequenceRun}
                />
              </ModuleViewBoundary>
            ) : null}
          </>
        )}
      </Box>
    </Paper>
  )
})

class ModuleViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'This module could not render.' }
  }

  render() {
    if (this.state.error) {
      return (
        <Alert color="red" variant="light" p="xs">
          {this.state.error}
        </Alert>
      )
    }
    return this.props.children
  }
}

function GripIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2 1.5h2v2H2zm6 0h2v2H8zM2 6h2v2H2zm6 0h2v2H8zM2 10.5h2v2H2zm6 0h2v2H8z"
      />
    </svg>
  )
}
