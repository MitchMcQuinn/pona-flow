import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { cssVariablesResolver, theme } from './theme'

export function ConsoleFrame({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    setTarget(ref.current)
  }, [])

  const portalTheme = useMemo(() => {
    if (!target) return theme
    return {
      ...theme,
      components: {
        ...theme.components,
        Portal: { defaultProps: { target } },
      },
    }
  }, [target])

  return (
    <div className={className ? `panel consolePanel ${className}` : 'panel consolePanel'}>
      <div ref={ref} className="panel__body consoleHost">
        {target ? (
          <MantineProvider
            theme={portalTheme}
            forceColorScheme="dark"
            cssVariablesSelector=".consoleHost"
            cssVariablesResolver={cssVariablesResolver}
            getRootElement={() => ref.current ?? undefined}
          >
            <Notifications position="top-right" />
            {children}
          </MantineProvider>
        ) : null}
      </div>
    </div>
  )
}
