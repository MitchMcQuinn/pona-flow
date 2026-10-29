export async function postModuleAction(input: {
  actionUrl: string
  dashboardId: string
  moduleId: string
  moduleType: string
  value: unknown
}) {
  await postJson(input.actionUrl, {
    dashboardId: input.dashboardId,
    moduleId: input.moduleId,
    moduleType: input.moduleType,
    value: input.value,
  })
}

export async function postViewAction(input: {
  actionUrl: string
  dashboardId: string
  viewId: string
  value: unknown
}) {
  await postJson(input.actionUrl, {
    dashboardId: input.dashboardId,
    viewId: input.viewId,
    moduleType: 'form',
    value: input.value,
  })
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
}
