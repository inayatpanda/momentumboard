import type { Context } from '@netlify/functions'
import { validateConfig } from '../../shared/config'
import { blobAppStore, type AppStore } from './lib/store'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routeConfig(
  url: URL,
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const appOk = !!env.APP_TOKEN && headers.get('x-app-token') === env.APP_TOKEN
  // read-only views are also open to the research routine's report token
  const reportOk = !!env.REPORT_TOKEN && headers.get('x-report-token') === env.REPORT_TOKEN
  if (!appOk && !(method === 'GET' && reportOk)) return json(401, { ok: false, error: 'unauthorized' })

  if (method === 'GET') {
    if (url.searchParams.get('view') === 'signals') {
      const signals = (await store.read<unknown[]>('signal-log')) ?? []
      return json(200, { ok: true, data: signals })
    }
    if (url.searchParams.get('view') === 'runlog') {
      const runlog = (await store.read<unknown[]>('runlog')) ?? []
      return json(200, { ok: true, data: runlog.slice(-20) })
    }
    if (url.searchParams.get('view') === 'history') {
      const history = (await store.read<unknown[]>('alert-history')) ?? []
      return json(200, { ok: true, data: history.slice(-50).reverse() })
    }
    return json(200, { ok: true, data: await store.read('config') })
  }

  if (method === 'PUT') {
    const cfg = validateConfig(bodyText ? JSON.parse(bodyText) : null)
    if (!cfg) return json(400, { ok: false, error: 'invalid-config' })
    await store.write('config', cfg)
    return json(200, { ok: true, data: cfg })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeConfig(
    new URL(req.url),
    req.method,
    req.headers,
    req.method === 'PUT' ? await req.text() : null,
    { APP_TOKEN: process.env.APP_TOKEN, REPORT_TOKEN: process.env.REPORT_TOKEN },
    blobAppStore,
  )
