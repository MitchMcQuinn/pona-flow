import { useEffect, useState } from 'react'
import { useRefreshSignal } from './useRefreshSignal'
import type { TriggerKind } from '../types'

/**
 * External listen URLs use EventSource. A pona event uses an authenticated
 * fetch stream, because EventSource cannot send the Clerk bearer token.
 * A simulation-driven console subscribes to neither. Its only automatic
 * refresh is `externalToken`, which the session view bumps from the tic.
 */
export function useConsoleRefresh(input: {
  driven: boolean
  triggerKind: TriggerKind
  listenUrl: string
  consoleId: string
  externalToken: number
}) {
  const listenUrl = input.driven || input.triggerKind !== 'url' ? '' : input.listenUrl
  const eventConsoleId = input.driven || input.triggerKind !== 'event' ? '' : input.consoleId
  const { token, refreshNow } = useRefreshSignal(listenUrl)
  const engineToken = useEngineRefresh(eventConsoleId)
  // While driven, a leftover stream token must not refresh the console.
  // `refreshNow` still counts, so the manual button works without a subscription.
  const streamToken = input.driven ? 0 : engineToken
  return { token: token + streamToken + input.externalToken, refreshNow }
}

function useEngineRefresh(consoleId: string) {
  const [token, setToken] = useState(0)

  useEffect(() => {
    if (!consoleId) return
    const controller = new AbortController()
    let cancelled = false

    const pump = async () => {
      const response = await fetch(`/api/consoles/${encodeURIComponent(consoleId)}/listen`, {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!response.ok || !response.body) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!cancelled) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        if (chunks.some((chunk) => chunk.includes('event: refresh'))) {
          setToken((current) => current + 1)
        }
      }
    }

    pump().catch(() => undefined)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [consoleId])

  return token
}
