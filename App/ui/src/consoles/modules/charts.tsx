import { Box, Flex } from '@mantine/core'
import { AreaChart, BarChart, DonutChart, LineChart } from '@mantine/charts'
import type { MantineColor } from '@mantine/core'
import { ShapeNote } from '../components/ShapeNote'
import { asChartRows, configString } from './data'
import type { ModuleViewProps } from './types'

const chartShape = '[{ "name": "Mon", "value": 10 }]'
const donutShape = '[{ "name": "Packed", "value": 40, "color": "accent.4" }]'
const palette = ['accent.4', 'violet.5', 'pink.5', 'cyan.4', 'teal.4', 'red.4']

function chartRows(data: unknown) {
  const rows = asChartRows(data)
  if (!rows) return null
  return rows as Record<string, string | number>[]
}

function CartesianModule({
  data,
  config,
  kind,
}: ModuleViewProps & { kind: 'line' | 'bar' | 'area' }) {
  const rows = chartRows(data)
  if (!rows) return <ShapeNote expected={chartShape} />
  const dataKey = configString(config, 'categoryKey', 'name')
  const valueKey = configString(config, 'valueKey', 'value')
  const color = configString(config, 'color', 'accent.4') as MantineColor
  const series = [{ name: valueKey, color }]

  return (
    <Box h="100%" mih={140}>
      {kind === 'line' ? (
        <LineChart h="100%" data={rows} dataKey={dataKey} series={series} curveType="monotone" withDots={false} />
      ) : null}
      {kind === 'bar' ? <BarChart h="100%" data={rows} dataKey={dataKey} series={series} /> : null}
      {kind === 'area' ? (
        <AreaChart h="100%" data={rows} dataKey={dataKey} series={series} curveType="monotone" />
      ) : null}
    </Box>
  )
}

export function LineChartModule(props: ModuleViewProps) {
  return <CartesianModule {...props} kind="line" />
}

export function BarChartModule(props: ModuleViewProps) {
  return <CartesianModule {...props} kind="bar" />
}

export function AreaChartModule(props: ModuleViewProps) {
  return <CartesianModule {...props} kind="area" />
}

export function DonutChartModule({ data }: ModuleViewProps) {
  const rows = asChartRows(data)
  if (!rows) return <ShapeNote expected={donutShape} />
  const cells = rows.flatMap((row, index) => {
    const value = typeof row.value === 'number' ? row.value : Number(row.value)
    if (!Number.isFinite(value)) return []
    const name = typeof row.name === 'string' ? row.name : `Slice ${index + 1}`
    const color = (typeof row.color === 'string' ? row.color : palette[index % palette.length]) as MantineColor
    return [{ name, value, color }]
  })
  if (cells.length === 0) return <ShapeNote expected={donutShape} />
  const total = cells.reduce((sum, cell) => sum + cell.value, 0)

  return (
    <Flex h="100%" align="center" justify="center">
      <DonutChart data={cells} size={148} thickness={18} chartLabel={total} tooltipDataSource="segment" />
    </Flex>
  )
}
