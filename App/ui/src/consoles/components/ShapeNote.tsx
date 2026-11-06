import { Code, Text } from '@mantine/core'

export function ShapeNote({ expected }: { expected: string }) {
  return (
    <Text size="sm" c="dimmed">
      expected{' '}
      <Code style={{ whiteSpace: 'normal' }}>{expected}</Code>
    </Text>
  )
}
