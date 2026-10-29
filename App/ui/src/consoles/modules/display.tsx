import { Alert, Badge, Flex, Progress, RingProgress, Table, Text } from '@mantine/core'
import { ShapeNote } from '../components/ShapeNote'
import { configString, displayText, isRecord, moduleText, sequenceFieldLines } from './data'
import type { ModuleViewProps } from './types'

const statShape = '{ "value": 12, "label": "Open", "delta": "+4%" }'
const textShape = '{ "text": "Warehouse is clear." }'
const tableShape = '[{ "order": "1042", "status": "Packed" }]'
const badgeShape = '{ "label": "Live", "color": "accent" }'
const progressShape = '{ "value": 64, "label": "Pick rate" }'
const alertShape = '{ "title": "Lane 3", "message": "Waiting for a scan.", "color": "yellow" }'

function tableModel(data: unknown) {
  if (Array.isArray(data)) {
    const rows = data.filter(isRecord)
    if (rows.length !== data.length) return null
    const columns = rows[0] ? Object.keys(rows[0]) : []
    return { columns, rows }
  }
  if (!isRecord(data) || !Array.isArray(data.rows)) return null
  const rows = data.rows.filter(isRecord)
  if (rows.length !== data.rows.length) return null
  const columns = Array.isArray(data.columns)
    ? data.columns.map(String)
    : rows[0]
      ? Object.keys(rows[0])
      : []
  return { columns, rows }
}

export function StatModule({ data }: ModuleViewProps) {
  const record = isRecord(data) ? data : null
  let value = record ? displayText(record, ['value']) : displayText(data, ['value'])
  let label = record ? displayText(record, ['label']) : null
  if (value == null) {
    const numbers = sequenceFieldLines(data).filter((line) => line.numeric)
    if (numbers.length !== 1) return <ShapeNote expected={statShape} />
    value = numbers[0].value
    label = label || numbers[0].key
  }
  const delta = record && typeof record.delta === 'string' ? record.delta : null
  const negative = delta?.trim().startsWith('-') ?? false

  return (
    <Flex direction="column" justify="center" h="100%" gap={6}>
      {label ? (
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      ) : null}
      <Text className="stat-value" fz={34} fw={700} lh={1}>
        {value}
      </Text>
      {delta ? (
        <Text size="sm" fw={600} c={negative ? '#fb7185' : '#34d399'}>
          {delta}
        </Text>
      ) : null}
    </Flex>
  )
}

export function TextModule({ data }: ModuleViewProps) {
  const text = moduleText(data, ['text', 'message', 'body'])
  if (text != null) {
    return (
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </Text>
    )
  }
  const lines = sequenceFieldLines(data)
  if (lines.length === 0) return <ShapeNote expected={textShape} />
  return (
    <Flex direction="column" gap={8}>
      {lines.map((line) => (
        <Flex key={line.key} direction="column" gap={2}>
          <Text size="xs" c="dimmed">
            {line.key}
          </Text>
          <Text size="sm">{line.value}</Text>
        </Flex>
      ))}
    </Flex>
  )
}

export function TableModule({ data }: ModuleViewProps) {
  const model = tableModel(data)
  if (!model) return <ShapeNote expected={tableShape} />
  if (model.columns.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No rows
      </Text>
    )
  }

  return (
    <Table.ScrollContainer minWidth={280}>
      <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            {model.columns.map((column) => (
              <Table.Th key={column}>{column}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {model.rows.map((row, index) => (
            <Table.Tr key={index}>
              {model.columns.map((column) => (
                <Table.Td key={column}>{row[column] == null ? '' : String(row[column])}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

export function BadgeModule({ data }: ModuleViewProps) {
  const label = displayText(data, ['label', 'text', 'status'])
  if (label == null) return <ShapeNote expected={badgeShape} />
  const color = isRecord(data) && typeof data.color === 'string' ? data.color : 'accent'
  return (
    <Flex h="100%" align="center">
      <Badge color={color} size="lg" variant="light">
        {label}
      </Badge>
    </Flex>
  )
}

export function ProgressModule({ data }: ModuleViewProps) {
  const record = isRecord(data) ? data : null
  const raw = record && (typeof record.value === 'number' || typeof record.value === 'string') ? Number(record.value) : Number.NaN
  if (!Number.isFinite(raw)) return <ShapeNote expected={progressShape} />
  const value = Math.max(0, Math.min(100, raw))
  const label = record ? displayText(record, ['label']) : null
  const color = record && typeof record.color === 'string' ? record.color : 'accent'

  return (
    <Flex direction="column" justify="center" h="100%" gap="xs">
      {label ? <Text size="sm">{label}</Text> : null}
      <Progress value={value} color={color} size="lg" radius={0} />
      <Text size="xs" c="dimmed">
        {value}%
      </Text>
    </Flex>
  )
}

export function RingModule({ data }: ModuleViewProps) {
  const record = isRecord(data) ? data : null
  const raw = record && (typeof record.value === 'number' || typeof record.value === 'string') ? Number(record.value) : Number.NaN
  if (!Number.isFinite(raw)) return <ShapeNote expected={progressShape} />
  const value = Math.max(0, Math.min(100, raw))
  const label = record ? displayText(record, ['label']) : null
  const color = record && typeof record.color === 'string' ? record.color : 'accent'

  return (
    <Flex h="100%" align="center" justify="center" gap="md">
      <RingProgress
        size={116}
        thickness={10}
        roundCaps
        sections={[{ value, color }]}
        label={
          <Text ta="center" fw={700} size="lg">
            {value}%
          </Text>
        }
      />
      {label ? <Text size="sm">{label}</Text> : null}
    </Flex>
  )
}

export function AlertModule({ data, config }: ModuleViewProps) {
  const message = displayText(data, ['message', 'text', 'body'])
  if (message == null) return <ShapeNote expected={alertShape} />
  const title = isRecord(data) && typeof data.title === 'string' ? data.title : configString(config, 'title')
  const color = isRecord(data) && typeof data.color === 'string' ? data.color : configString(config, 'color', 'cyan')

  return (
    <Alert color={color} title={title || undefined} variant="light">
      {message}
    </Alert>
  )
}
