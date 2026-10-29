import { Group, Tabs, Text, UnstyledButton } from '@mantine/core'
import { setActiveView } from '../docStore'
import type { ConsoleRecord } from '../types'

type ViewBarProps = {
  dashboard: ConsoleRecord
  editing: boolean
  configuring: boolean
  onAdd: () => void
  onConfigure: () => void
}

export function ViewBar({ dashboard, editing, configuring, onAdd, onConfigure }: ViewBarProps) {
  return (
    <Tabs
      value={dashboard.activeViewId}
      onChange={(value) => {
        if (value) setActiveView(value)
      }}
    >
      <Tabs.List>
        {dashboard.views.map((view) => (
          <Tabs.Tab key={view.id} value={view.id}>
            {view.name}
            <Text span className="view-kind" c="dimmed">
              {view.kind}
            </Text>
          </Tabs.Tab>
        ))}
        {editing ? (
          <Group gap={0} wrap="nowrap" className="view-tab-actions">
            <UnstyledButton
              className="view-tab-action"
              aria-label="View settings"
              title="View settings"
              data-active={configuring ? 'true' : undefined}
              onClick={onConfigure}
            >
              <ViewSettingsIcon />
            </UnstyledButton>
            <UnstyledButton
              className="view-tab-action"
              aria-label="Add view"
              title="Add view"
              onClick={onAdd}
            >
              <AddViewIcon />
            </UnstyledButton>
          </Group>
        ) : null}
      </Tabs.List>
    </Tabs>
  )
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

function ViewSettingsIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
      <circle cx="9" cy="7" r="2.25" fill="#000" />
      <circle cx="15" cy="12" r="2.25" fill="#000" />
      <circle cx="8" cy="17" r="2.25" fill="#000" />
    </svg>
  )
}

function AddViewIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}
