import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routePortfolio(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const appOk = !!env.APP_TOKEN && headers.get('x-app-token') === env.APP_TOKEN
  const reportOk = !!env.REPORT_TOKEN && headers.get('x-report-token') === env.REPORT_TOKEN

  if (method === 'GET') {
    if (!appOk && !reportOk) return json(401, { ok: false, error: 'unauthorized' })
    return json(200, { ok: true, data: (await store.read('portfolio')) ?? null })
  }

  if (method === 'PUT') {
    if (!appOk) return json(401, { ok: false, error: 'unauthorized' })
    let snapshot: unknown
    try {
      snapshot = bodyText ? JSON.parse(bodyText) : null
    } catch {
      return json(400, { ok: false, error: 'invalid-json' })
    }
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray((snapshot as { openPositions?: unknown }).openPositions)) {
      return json(400, { ok: false, error: 'invalid-snapshot' })
    }
    await store.write('portfolio', { ...(snapshot as object), at: Math.floor(Date.now() / 1000) })
    return json(200, { ok: true })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routePortfolio(
    req.method,
    req.headers,
    req.method === 'PUT' ? await req.text() : null,
    { APP_TOKEN: process.env.APP_TOKEN, REPORT_TOKEN: process.env.REPORT_TOKEN },
    blobAppStore,
  )
