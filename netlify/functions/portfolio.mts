import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { authenticate } from './lib/auth'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routePortfolio(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const auth = await authenticate(headers, env, store)
  const reportOk = !!env.REPORT_TOKEN && headers.get('x-report-token') === env.REPORT_TOKEN
  const ns = auth?.ns ?? ''

  if (method === 'GET') {
    if (!auth && !reportOk) return json(401, { ok: false, error: 'unauthorized' })
    // the research routine (report token) always reads the ADMIN portfolio
    return json(200, { ok: true, data: (await store.read(`${auth ? ns : ''}portfolio`)) ?? null })
  }

  if (method === 'PUT') {
    if (!auth) return json(401, { ok: false, error: 'unauthorized' })
    let snapshot: unknown
    try {
      snapshot = bodyText ? JSON.parse(bodyText) : null
    } catch {
      return json(400, { ok: false, error: 'invalid-json' })
    }
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray((snapshot as { openPositions?: unknown }).openPositions)) {
      return json(400, { ok: false, error: 'invalid-snapshot' })
    }
    await store.write(`${ns}portfolio`, { ...(snapshot as object), at: Math.floor(Date.now() / 1000) })
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
