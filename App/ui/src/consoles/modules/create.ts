import { getModuleDefinition } from './registry'
import type { ModuleInstance } from '../types'

export function createModuleInstance(
  type: string,
  position: { x: number; y: number },
  title?: string,
): ModuleInstance | null {
  const definition = getModuleDefinition(type)
  if (!definition) return null
  return {
    id: crypto.randomUUID(),
    type,
    title: title ?? definition.title,
    dataSource: 'url',
    dataUrl: definition.defaultDataUrl,
    dataSequenceId: '',
    actionSource: 'url',
    actionUrl: definition.kind === 'action' ? definition.defaultActionUrl : '',
    actionSequenceId: '',
    config: { ...definition.defaultConfig },
    layout: {
      x: position.x,
      y: position.y,
      w: definition.defaultLayout.w,
      h: definition.defaultLayout.h,
      minW: definition.defaultLayout.minW,
      minH: definition.defaultLayout.minH,
    },
  }
}
