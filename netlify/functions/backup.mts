import type { Context } from '@netlify/functions'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'
import { backupSettings } from '../../shared/backupSettings'

// Full journal/config backup to the site's private Blobs storage. The device's
// IndexedDB is the primary copy; this protects it from cleared browser storage
// and enables restore on a new device. App token only — this is personal data.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', vary: 'x-app-token' } })

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
    const saved = await store.read<Record<string, unknown>>(`${ns}journal-backup`)
    if (!saved) return json(200, { ok: true, data: null })
    const clean = { trades: saved.trades, rules: saved.rules, watchlist: saved.watchlist, settings: backupSettings(saved.settings), at: saved.at }
    // Older clients uploaded every setting. Never restore a credential from
    // those backups, and remove it from storage when that backup is opened.
    if (JSON.stringify(saved) !== JSON.stringify(clean)) await store.write(`${ns}journal-backup`, clean)
    return json(200, { ok: true, data: clean })
  }

  if (method === 'PUT') {
    if (!bodyText || bodyText.length > MAX_BYTES) return json(400, { ok: false, error: 'invalid-backup' })
    let parsed: { trades?: unknown[]; rules?: unknown[]; watchlist?: unknown[]; settings?: unknown[] }
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return json(400, { ok: false, error: 'invalid-json' })
    }
    if (!parsed || !Array.isArray(parsed.trades)) return json(400, { ok: false, error: 'invalid-backup' })
    await store.write(`${ns}journal-backup`, { trades: parsed.trades, rules: parsed.rules, watchlist: parsed.watchlist, settings: backupSettings(parsed.settings), at: Math.floor(Date.now() / 1000) })
    return json(200, { ok: true })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeBackup(req.method, req.headers, req.method === 'PUT' ? await req.text() : null, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
