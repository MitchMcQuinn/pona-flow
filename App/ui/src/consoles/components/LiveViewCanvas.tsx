import { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Stack, Text } from '@mantine/core'
import GridLayout, { useContainerWidth, type Layout } from 'react-grid-layout'
import { ModuleCard } from './ModuleCard'
import { ModuleInspector } from './ModuleInspector'
import { updateModuleLayouts } from '../docStore'
import type { LiveDashboardView } from '../types'

function toLayout(modules: LiveDashboardView['modules']): Layout {
  return modules.map((module) => ({
    i: module.id,
    x: module.layout.x,
    y: module.layout.y,
    w: module.layout.w,
    h: module.layout.h,
    minW: module.layout.minW,
    minH: module.layout.minH,
  }))
}

function sameLayout(left: Layout, right: Layout) {
  if (left.length !== right.length) return false
  return left.every((item) => {
    const other = right.find((entry) => entry.i === item.i)
    return Boolean(other && item.x === other.x && item.y === other.y && item.w === other.w && item.h === other.h)
  })
}

type LiveViewCanvasProps = {
  spaceId: string
  dashboardId: string
  view: LiveDashboardView
  editing: boolean
  refreshToken: number
  onConsoleRefresh: () => void
  onAddRequest: () => void
  fluid?: boolean
}

export function LiveViewCanvas({
  spaceId,
  dashboardId,
  view,
  editing,
  refreshToken,
  onConsoleRefresh,
  onAddRequest,
  fluid,
}: LiveViewCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { width, containerRef, mounted } = useContainerWidth()
  const storedLayout = useMemo(() => toLayout(view.modules), [view.modules])
  const dragging = useRef(false)
  const [layoutOverride, setLayoutOverride] = useState<Layout | null>(null)
  const layout = layoutOverride ?? storedLayout
  const onSelect = useCallback((moduleId: string) => setSelectedId(moduleId), [])
  const selected = view.modules.find((module) => module.id === selectedId) ?? null

  const children = useMemo(
    () =>
      view.modules.map((module) => (
        <div key={module.id}>
          <ModuleCard
            dashboardId={dashboardId}
            viewId={view.id}
            module={module}
            refreshToken={refreshToken}
            onConsoleRefresh={onConsoleRefresh}
            editing={editing}
            selected={selectedId === module.id}
            onSelect={onSelect}
          />
        </div>
      )),
    [dashboardId, view.id, view.modules, refreshToken, onConsoleRefresh, editing, selectedId, onSelect],
  )

  const beginInteraction = () => {
    dragging.current = true
  }

  const persistLayout = (next: Layout) => {
    dragging.current = false
    updateModuleLayouts(view.id, next)
    setLayoutOverride(null)
  }

  const selectedModule = editing ? selected : null

  return (
    <>
      {editing ? (
        <Text size="sm" c="dimmed">
          Drag a module header to move it. Drag the corner to resize. Click a module to choose its data.
        </Text>
      ) : null}

      {view.modules.length === 0 ? (
        <Box className="empty-canvas">
          <Stack align="flex-start" gap="xs">
            <Text fw={600}>This live view is empty</Text>
            <Text size="sm" c="dimmed">
              Add a module from the Mantine catalog.
            </Text>
            <button type="button" className="panelTextButton" onClick={onAddRequest}>
              Add module
            </button>
          </Stack>
        </Box>
      ) : (
        <Box style={{ overflowX: 'auto' }}>
          <div ref={containerRef} style={fluid ? undefined : { minWidth: 960 }}>
            {mounted && width > 0 ? (
              <GridLayout
                className="dashboard-grid"
                layout={layout}
                width={width}
                gridConfig={{ cols: 12, rowHeight: 32, margin: [12, 12], containerPadding: [0, 0] }}
                dragConfig={{
                  enabled: editing,
                  handle: '.module-drag-handle',
                  cancel: 'button, a, input, textarea',
                  bounded: false,
                  threshold: 3,
                  allowMobileScroll: true,
                }}
                resizeConfig={{ enabled: editing, handles: ['se'] }}
                onLayoutChange={(next) => {
                  if (!dragging.current) return
                  setLayoutOverride((current) => (current && sameLayout(current, next) ? current : next))
                }}
                onDragStart={beginInteraction}
                onResizeStart={beginInteraction}
                onDragStop={persistLayout}
                onResizeStop={persistLayout}
              >
                {children}
              </GridLayout>
            ) : null}
          </div>
        </Box>
      )}

      <ModuleInspector
        spaceId={spaceId}
        viewId={view.id}
        module={selectedModule}
        opened={selectedModule != null}
        onClose={() => setSelectedId(null)}
      />
    </>
  )
}
