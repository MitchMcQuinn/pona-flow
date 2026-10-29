import { previewSequenceParameters } from '../services/api'
import { webhookParameterPages, type WebhookParameter } from './webhookFields'

export async function readCallerWebhookParameters(spaceId: string, sequenceId: string): Promise<{
  pages: WebhookParameter[][]
  parameters: WebhookParameter[]
}> {
  const preview = await previewSequenceParameters({ spaceId, sequenceId })
  const steps =
    Array.isArray(preview.parameter_steps) && preview.parameter_steps.length > 0
      ? preview.parameter_steps
      : [preview.parameters ?? []]
  const pages = webhookParameterPages(steps, preview.parameter_values, preview.response_parameter_names ?? [])
  return { pages, parameters: pages.flat() }
}
