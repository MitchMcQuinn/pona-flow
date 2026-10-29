import { useMemo } from 'react'
import { Box, Text } from '@mantine/core'
import { GraphView } from '../../components/results/GraphView'
import { ShapeNote } from '../components/ShapeNote'
import { graphPayloadFromModuleData } from './graphPayload'
import type { ModuleViewProps } from './types'

const graphShape =
  '{ "nodes": [{ "id": "a", "label": "Order" }], "relationships": [{ "source": "a", "target": "b", "type": "PLACED" }] }'

export function GraphModule({ data }: ModuleViewProps) {
  const graph = useMemo(() => graphPayloadFromModuleData(data), [data])
  if (!graph) return <ShapeNote expected={graphShape} />
  if (graph.nodes.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No nodes
      </Text>
    )
  }

  return (
    <Box className="console-graph">
      <GraphView graph={graph} />
    </Box>
  )
}
