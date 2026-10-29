import { createContext, useContext, type ReactNode } from 'react'

export type SequenceOption = { value: string; label: string }

const SequenceOptionsContext = createContext<SequenceOption[]>([])

export function SequenceOptionsProvider({
  options,
  children,
}: {
  options: SequenceOption[]
  children: ReactNode
}) {
  return <SequenceOptionsContext.Provider value={options}>{children}</SequenceOptionsContext.Provider>
}

export function useSequenceOptions() {
  return useContext(SequenceOptionsContext)
}
