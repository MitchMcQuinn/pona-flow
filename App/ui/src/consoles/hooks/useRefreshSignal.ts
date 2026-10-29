import { useCallback, useEffect, useState } from 'react'

export type SignalStatus = 'off' | 'connecting' | 'connected' | 'reconnecting'

export function useRefreshSignal(listenUrl: string) {
  const [token, setToken] = useState(0)
  const [connection, setConnection] = useState<{ url: string; status: SignalStatus }>(() => ({
    url: listenUrl,
    status: listenUrl ? 'connecting' : 'off',
  }))

  if (connection.url !== listenUrl) {
    setConnection({ url: listenUrl, status: listenUrl ? 'connecting' : 'off' })
  }

  const refreshNow = useCallback(() => {
    setToken((current) => current + 1)
  }, [])

  useEffect(() => {
    if (!listenUrl) return
    const source = new EventSource(listenUrl)
    const bump = () => setToken((current) => current + 1)
    const setStatus = (status: SignalStatus) => {
      setConnection((current) => (current.url === listenUrl ? { url: listenUrl, status } : current))
    }
    source.onopen = () => setStatus('connected')
    source.onmessage = bump
    source.addEventListener('refresh', bump)
    source.onerror = () => setStatus('reconnecting')

    return () => {
      source.removeEventListener('refresh', bump)
      source.close()
    }
  }, [listenUrl])

  const status = connection.url === listenUrl ? connection.status : listenUrl ? 'connecting' : 'off'
  return { token, status, refreshNow }
}
