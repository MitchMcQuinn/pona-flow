import { Code, Text } from '@mantine/core'

export function ShapeNote({ expected }: { expected: string }) {
  return (
    <Text size="sm" c="dimmed">
      Expected{' '}
      <Code style={{ whiteSpace: 'normal' }}>{expected}</Code>
    </Text>
  )
}
