// The remote D1 — Cloudflare's REST API wearing the D1Database shape.
//
// M2 left a deliberate throw where a Node process asked for STORE_BACKEND=d1:
// bindings exist only inside workerd, so scripts (the importer, scripts/bg/ on
// Actions) need D1 over HTTPS. This is that client. Same slice of the API as
// sqliteD1 — prepare/bind/first/run/all/batch — against
// POST /accounts/{account}/d1/database/{db}/query, one statement per request,
// values as bound params (which is what lets a 300KB blob value through: D1's
// statement-length cap counts SQL text, not bindings).
//
// Auth: CLOUDFLARE_API_TOKEN if set, else wrangler's own OAuth token from
// ~/Library/Preferences/.wrangler/config/default.toml (macOS) or
// ~/.config/.wrangler/config/default.toml. OAuth tokens expire hourly; on a
// 401 the file is re-read once — run any wrangler command to refresh it.
//
// The API is rate-limited (1200 requests / 5 min across the account), so calls
// are spaced MIN_GAP_MS apart and 429/5xx get a backoff retry. This client is
// for scripts — imports, backfills, smoke checks — not for serving traffic.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { D1Database, D1PreparedStatement, D1Result } from '../../netlify/functions/lib/d1Store'

const API = 'https://api.cloudflare.com/client/v4'
const MIN_GAP_MS = 260
const RETRIES = 5

function wranglerConfigPaths(): string[] {
  return [
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.wrangler', 'config', 'default.toml'),
  ]
}

export function loadWranglerOauthToken(): string | null {
  for (const p of wranglerConfigPaths()) {
    try {
      const m = readFileSync(p, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)
      if (m) return m[1]
    } catch {
      /* next path */
    }
  }
  return null
}

export interface HttpD1Options {
  accountId: string
  databaseId: string
  /** Explicit token wins; otherwise wrangler's OAuth token is read from disk. */
  apiToken?: string
}

/** The zero-argument form scripts want: account from CLOUDFLARE_ACCOUNT_ID,
 * database id from D1_DATABASE_ID or wrangler.toml (the single place M3 wrote
 * it), token from CLOUDFLARE_API_TOKEN or wrangler's login. Throws — loudly,
 * naming the missing piece — rather than guessing. */
export function openHttpD1FromEnv(): ReturnType<typeof openHttpD1> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) throw new Error('httpD1: CLOUDFLARE_ACCOUNT_ID is not set')
  let databaseId = process.env.D1_DATABASE_ID
  if (!databaseId) {
    try {
      const toml = readFileSync(join(process.cwd(), 'wrangler.toml'), 'utf8')
      databaseId = toml.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1]
    } catch {
      /* fall through to the throw below */
    }
  }
  if (!databaseId) throw new Error('httpD1: no D1_DATABASE_ID and no database_id in ./wrangler.toml')
  return openHttpD1({ accountId, databaseId })
}

interface QueryResult {
  results?: unknown[]
  success: boolean
  meta?: { changes?: number; last_row_id?: number }
}

export function openHttpD1(opts: HttpD1Options): D1Database & { close(): void } {
  let token = opts.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? loadWranglerOauthToken()
  if (!token) {
    throw new Error(
      'httpD1: no Cloudflare credential. Set CLOUDFLARE_API_TOKEN or log in with `npx wrangler login`.',
    )
  }
  const url = `${API}/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`

  let last = 0
  const throttle = async () => {
    const wait = last + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    last = Date.now()
  }

  async function query(sql: string, params: unknown[]): Promise<QueryResult> {
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      await throttle()
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      }).catch((e: unknown) => e as Error)

      // Transport failure — retry like a 5xx.
      if (res instanceof Error) {
        if (attempt < RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
          continue
        }
        throw res
      }

      if (res.status === 401 && !refreshed) {
        // The OAuth token rotates hourly; wrangler may have refreshed it on disk.
        const next = process.env.CLOUDFLARE_API_TOKEN ?? loadWranglerOauthToken()
        refreshed = true
        if (next && next !== token) {
          token = next
          continue
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const after = Number(res.headers.get('retry-after'))
        await new Promise(r => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt))
        continue
      }

      const body = (await res.json().catch(() => null)) as {
        success?: boolean
        errors?: { code?: number; message?: string }[]
        result?: QueryResult[]
      } | null
      if (!res.ok || !body?.success) {
        const err = body?.errors?.map(e => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`
        throw new Error(`httpD1: query failed — ${err}\n  sql: ${sql.slice(0, 120)}`)
      }
      return body.result?.[0] ?? { success: true, results: [] }
    }
  }

  const statement = (sql: string, bound: unknown[]): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return statement(sql, values)
    },
    async first<T = unknown>(): Promise<T | null> {
      const r = await query(sql, bound)
      return ((r.results?.[0] as T | undefined) ?? null)
    },
    async run<T = unknown>(): Promise<D1Result<T>> {
      const r = await query(sql, bound)
      return {
        success: true,
        results: (r.results ?? []) as T[],
        meta: { changes: r.meta?.changes ?? 0, last_row_id: r.meta?.last_row_id },
      }
    },
    async all<T = unknown>(): Promise<D1Result<T>> {
      const r = await query(sql, bound)
      return { success: true, results: (r.results ?? []) as T[], meta: { changes: r.meta?.changes ?? 0 } }
    },
  })

  return {
    prepare: (sql: string) => statement(sql, []),
    // No transaction over HTTP — sequential is the honest semantics here, and
    // the importer's writes are idempotent upserts, so a mid-batch failure
    // re-runs clean.
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = []
      for (const s of statements) out.push(await (s as D1PreparedStatement).run<T>())
      return out
    },
    close() {
      /* nothing to release */
    },
  }
}
