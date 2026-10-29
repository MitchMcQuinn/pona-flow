import { useCallback, useEffect, useState } from 'react'
import { runConsoleSequence } from '../../services/api'
import type { ModuleSourceKind } from '../types'

export type ModuleDataInput = {
  kind: ModuleSourceKind
  dataUrl: string
  sequenceId: string
  consoleId: string
  viewId: string
  moduleId: string
}

type Result = {
  key: string
  token: number
  local: number
  data: unknown
  error: string | null
}

function sourceKey(input: ModuleDataInput) {
  if (input.kind === 'sequence') {
    const sequenceId = input.sequenceId.trim()
    return sequenceId ? `sequence:${sequenceId}` : ''
  }
  const url = input.dataUrl.trim()
  return url ? `url:${url}` : ''
}

async function readUrl(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function useModuleData(input: ModuleDataInput, refreshToken: number) {
  const { kind, dataUrl, sequenceId, consoleId, viewId, moduleId } = input
  const key = sourceKey(input)
  const [localToken, setLocalToken] = useState(0)
  const [result, setResult] = useState<Result | null>(null)

  const refetch = useCallback(() => {
    setLocalToken((current) => current + 1)
  }, [])

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    let cancelled = false
    const token = refreshToken
    const local = localToken

    const request =
      kind === 'sequence'
        ? runConsoleSequence({
            consoleId,
            sequenceId: sequenceId.trim(),
            viewId,
            role: 'data',
            params: { console_id: consoleId, view_id: viewId, module_id: moduleId },
          })
        : readUrl(dataUrl.trim(), controller.signal)

    request
      .then((body) => {
        if (cancelled) return
        setResult({ key, token, local, data: body, error: null })
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        const message = reason instanceof Error ? reason.message : 'Request failed'
        setResult((previous) => ({
          key,
          token,
          local,
          data: previous?.key === key ? previous.data : null,
          error: message,
        }))
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [key, kind, dataUrl, sequenceId, consoleId, viewId, moduleId, refreshToken, localToken])

  const current =
    result && result.key === key && result.token === refreshToken && result.local === localToken ? result : null
  const visible = current ?? (result?.key === key ? result : null)

  return {
    data: key ? (visible?.data ?? null) : null,
    loading: Boolean(key) && current == null,
    error: key ? (current?.error ?? null) : null,
    refetch,
  }
}
