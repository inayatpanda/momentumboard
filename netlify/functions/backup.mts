import type { Context } from '@netlify/functions'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'

// Full journal/config backup to the site's private Blobs storage. The device's
// IndexedDB is the primary copy; this protects it from cleared browser storage
// and enables restore on a new device. App token only — this is personal data.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const MAX_BYTES = 2_000_000

export async function routeBackup(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const auth = await authenticate(headers, env, store)
  if (!auth) return json(401, { ok: false, error: 'unauthorized' })
  const ns = auth.ns

  if (method === 'GET') {
    return json(200, { ok: true, data: (await store.read(`${ns}journal-backup`)) ?? null })
  }

  if (method === 'PUT') {
    if (!bodyText || bodyText.length > MAX_BYTES) return json(400, { ok: false, error: 'invalid-backup' })
    let parsed: { trades?: unknown[]; rules?: unknown[]; watchlist?: unknown[]; settings?: unknown[] }
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return json(400, { ok: false, error: 'invalid-json' })
    }
    if (!Array.isArray(parsed.trades)) return json(400, { ok: false, error: 'invalid-backup' })
    await store.write(`${ns}journal-backup`, { ...parsed, at: Math.floor(Date.now() / 1000) })
    return json(200, { ok: true })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeBackup(req.method, req.headers, req.method === 'PUT' ? await req.text() : null, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
