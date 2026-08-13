// M-2: the remote D1 client had NO tests.
//
// It is the only path the GitHub Actions workers and the importer have to the
// production database — every morning's board, every drained queue item, and
// the 2,022-row rescue all went through code that nothing exercised. Its whole
// value is in the awkward paths (the retry ladder, the rotating OAuth token,
// the 429 spacing, the socket timeout), and those are exactly the ones a live
// smoke run never reaches.
//
// Mocked at the `https.request` boundary, which is the real seam: everything
// above it — throttling, backoff, token refresh, error shaping, meta mapping —
// is this file's own logic and is what is under test. Fake timers throughout,
// so a five-attempt backoff ladder costs no wall-clock seconds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('node:https', () => {
  class Agent {}
  return { Agent, request: requestMock, default: { Agent, request: requestMock } }
})

const { DEFAULT_TIMEOUT_MS, MIN_GAP_MS, RETRIES, openHttpD1 } = await import('./httpD1')

const OPTS = { accountId: 'acct', databaseId: 'dbid', apiToken: 'tkn' }
const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/acct/d1/database/dbid/query'

type Plan =
  | { kind: 'reply'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'error'; message: string }
  /** A socket that accepts the request and never answers — the I-3 case. */
  | { kind: 'hang' }

const ok = (result: unknown) => ({ kind: 'reply' as const, status: 200, body: JSON.stringify({ success: true, result: [result] }) })
const rows = (results: unknown[], meta?: Record<string, unknown>) => ok({ success: true, results, ...(meta ? { meta } : {}) })

interface Call {
  url: string
  authorization: string
  body: string
  at: number
  timeout: number | undefined
}

/** Answer each successive request with the next plan; the last one repeats. */
function plan(...plans: Plan[]): Call[] {
  const calls: Call[] = []
  let i = 0
  requestMock.mockImplementation((url: string, options: Record<string, unknown>, onResponse: (res: unknown) => void) => {
    const current = plans[Math.min(i++, plans.length - 1)]
    const handlers: Record<string, (arg?: unknown) => void> = {}
    let idle: ReturnType<typeof setTimeout> | undefined
    const req = {
      on(event: string, fn: (arg?: unknown) => void) {
        handlers[event] = fn
        return req
      },
      end(body: string) {
        const headers = options.headers as Record<string, string>
        calls.push({ url, authorization: headers.authorization, body, at: Date.now(), timeout: options.timeout as number | undefined })
        // Node fires 'timeout' after `options.timeout` of socket inactivity.
        if (options.timeout) idle = setTimeout(() => handlers.timeout?.(), options.timeout as number)
        if (current.kind === 'hang') return
        setTimeout(() => {
          clearTimeout(idle)
          if (current.kind === 'error') return handlers.error?.(new Error(current.message))
          const res = {
            statusCode: current.status,
            headers: current.headers ?? {},
            on(event: string, fn: (chunk?: unknown) => void) {
              if (event === 'data' && current.body) fn(Buffer.from(current.body))
              if (event === 'end') fn()
              return res
            },
          }
          onResponse(res)
        }, 0)
      },
      destroy(err?: Error) {
        clearTimeout(idle)
        handlers.error?.(err ?? new Error('destroyed'))
      },
    }
    return req
  })
  return calls
}

/** Let every pending timer (throttle, backoff, the fake socket) run out.
 * The no-op catch marks the rejection handled WHILE the clock is being pumped —
 * without it Node reports an unhandled rejection before the caller's
 * `.rejects` matcher has had a chance to attach. The promise is still returned
 * and still rejects. */
function settle<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined)
  return (async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    return p
  })()
}

beforeEach(() => {
  vi.useFakeTimers()
  requestMock.mockReset()
  delete process.env.CLOUDFLARE_API_TOKEN
})
afterEach(() => {
  vi.useRealTimers()
  delete process.env.CLOUDFLARE_API_TOKEN
})

describe('the happy path', () => {
  it('posts one statement with its parameters bound, and hands back the rows', async () => {
    const calls = plan(rows([{ key: 'runlog', value: '[]' }]))
    const db = openHttpD1(OPTS)
    const row = await settle(db.prepare('SELECT value FROM blobs WHERE store = ?1 AND key = ?2').bind('app', 'runlog').first())

    expect(row).toEqual({ key: 'runlog', value: '[]' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ENDPOINT)
    expect(calls[0].authorization).toBe('Bearer tkn')
    // Bound params, not interpolated SQL — this is what lets a 306KB value
    // through a statement-length cap that counts SQL text only.
    expect(JSON.parse(calls[0].body)).toEqual({ sql: 'SELECT value FROM blobs WHERE store = ?1 AND key = ?2', params: ['app', 'runlog'] })
  })

  it('maps run() onto D1Result meta, and reports no meta as no changes', async () => {
    plan(rows([], { changes: 3, last_row_id: 7 }))
    expect(await settle(openHttpD1(OPTS).prepare('DELETE FROM blobs').run())).toEqual({ success: true, results: [], meta: { changes: 3, last_row_id: 7 } })

    // The failure this guards: `meta.changes ?? 0`. The atomic lease reads
    // exactly this number and treats 0 as "someone else holds it", so a missing
    // meta must read as 0 and never as undefined.
    plan(rows([]))
    const bare = await settle(openHttpD1(OPTS).prepare('INSERT INTO blobs VALUES (1)').run())
    expect(bare.meta).toEqual({ changes: 0, last_row_id: undefined })
    expect(bare.meta!.changes).toBe(0)
  })

  it('all() carries the rows, first() takes the head, and an empty result is null not undefined', async () => {
    plan(rows([{ n: 1 }, { n: 2 }]))
    const db = openHttpD1(OPTS)
    expect((await settle(db.prepare('SELECT n').all())).results).toEqual([{ n: 1 }, { n: 2 }])
    plan(rows([]))
    expect(await settle(openHttpD1(OPTS).prepare('SELECT n').first())).toBeNull()
  })

  // A binding on a prepared statement must not mutate the one it came from.
  it('keeps each bind() a separate statement', async () => {
    const calls = plan(rows([]))
    const db = openHttpD1(OPTS)
    const stmt = db.prepare('SELECT ?1')
    await settle(stmt.bind('a').first())
    await settle(stmt.bind('b').first())
    expect(calls.map(c => JSON.parse(c.body).params)).toEqual([['a'], ['b']])
  })
})

/* ─────────────────────────────── I-3 ─────────────────────────────── */

describe('a socket that never answers', () => {
  it('asks for a timeout on every request, 30s by default and overridable', async () => {
    const calls = plan(rows([]))
    await settle(openHttpD1(OPTS).prepare('SELECT 1').first())
    expect(calls[0].timeout).toBe(DEFAULT_TIMEOUT_MS)
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)

    const other = plan(rows([]))
    await settle(openHttpD1({ ...OPTS, timeoutMs: 5_000 }).prepare('SELECT 1').first())
    expect(other[0].timeout).toBe(5_000)
  })

  // Without this the promise never settles and the Actions job hangs until the
  // runner's own 25-minute limit kills it — taking the morning paper with it.
  it('destroys it, enters the existing retry ladder, and succeeds on the next attempt', async () => {
    const calls = plan({ kind: 'hang' }, rows([{ ok: 1 }]))
    const row = await settle(openHttpD1({ ...OPTS, timeoutMs: 1_000 }).prepare('SELECT 1').first())
    expect(row).toEqual({ ok: 1 })
    expect(calls).toHaveLength(2)
    // The retry waits for the timeout AND then the backoff — it does not
    // stampede the endpoint the microsecond the socket dies.
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1_000 + 1_000)
  })

  it('gives up loudly rather than hanging, when every attempt black-holes', async () => {
    const calls = plan({ kind: 'hang' })
    await expect(settle(openHttpD1({ ...OPTS, timeoutMs: 1_000 }).prepare('SELECT 1').first())).rejects.toThrow(/socket timeout/)
    expect(calls).toHaveLength(RETRIES + 1)
  })
})

/* ──────────────────────────── the retry ladder ──────────────────────────── */

describe('transport failures', () => {
  it('retries with a doubling backoff and returns the eventual answer', async () => {
    const calls = plan({ kind: 'error', message: 'ECONNRESET' }, { kind: 'error', message: 'ECONNRESET' }, rows([{ ok: 1 }]))
    expect(await settle(openHttpD1(OPTS).prepare('SELECT 1').first())).toEqual({ ok: 1 })
    expect(calls).toHaveLength(3)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1_000)
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(2_000)
  })

  it('rethrows the real error once the retries are spent', async () => {
    const calls = plan({ kind: 'error', message: 'EAI_AGAIN api.cloudflare.com' })
    await expect(settle(openHttpD1(OPTS).prepare('SELECT 1').first())).rejects.toThrow('EAI_AGAIN api.cloudflare.com')
    expect(calls).toHaveLength(RETRIES + 1)
  })
})

describe('rate limiting', () => {
  // The account limit is 1200 requests / 5 min, shared with everything else on
  // it. When Cloudflare says how long to wait, waiting less is just a second 429.
  it('honours retry-after on a 429 in preference to its own backoff', async () => {
    const calls = plan({ kind: 'reply', status: 429, body: '{"success":false}', headers: { 'retry-after': '4' } }, rows([{ ok: 1 }]))
    expect(await settle(openHttpD1(OPTS).prepare('SELECT 1').first())).toEqual({ ok: 1 })
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(4_000)
  })

  it('falls back to the doubling backoff when the 429 carries no retry-after', async () => {
    const calls = plan({ kind: 'reply', status: 429, body: 'slow down' }, rows([{ ok: 1 }]))
    await settle(openHttpD1(OPTS).prepare('SELECT 1').first())
    const gap = calls[1].at - calls[0].at
    expect(gap).toBeGreaterThanOrEqual(1_000)
    expect(gap).toBeLessThan(4_000)
  })

  it('retries a 5xx and gives up with the status when it never clears', async () => {
    const calls = plan({ kind: 'reply', status: 503, body: 'upstream unavailable' })
    await expect(settle(openHttpD1(OPTS).prepare('SELECT 1').first())).rejects.toThrow(/HTTP 503/)
    expect(calls).toHaveLength(RETRIES + 1)
  })

  // The throttle is the whole reason a 2,000-row import does not trip the
  // account limit on its own.
  it('spaces consecutive queries at least MIN_GAP_MS apart', async () => {
    const calls = plan(rows([]))
    const db = openHttpD1(OPTS)
    const run = (async () => {
      for (let i = 0; i < 4; i++) await db.prepare(`SELECT ${i}`).first()
    })()
    await settle(run)
    expect(calls).toHaveLength(4)
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at, `gap ${i}`).toBeGreaterThanOrEqual(MIN_GAP_MS)
  })
})

/* ────────────────────────── the rotating credential ────────────────────────── */

describe('the OAuth token rotates hourly', () => {
  it('re-reads it once on a 401 and retries with the fresh one', async () => {
    const calls = plan({ kind: 'reply', status: 401, body: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' }, rows([{ ok: 1 }]))
    const db = openHttpD1(OPTS) // starts with 'tkn'
    process.env.CLOUDFLARE_API_TOKEN = 'refreshed' // wrangler wrote a new one
    expect(await settle(db.prepare('SELECT 1').first())).toEqual({ ok: 1 })
    expect(calls.map(c => c.authorization)).toEqual(['Bearer tkn', 'Bearer refreshed'])
  })

  // ONCE. A 401 that is genuinely a bad credential must fail immediately and
  // say so, not spin through the ladder five times per statement.
  it('fails loud, and without retrying, when the token on disk is the same one', async () => {
    const calls = plan({ kind: 'reply', status: 401, body: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' })
    process.env.CLOUDFLARE_API_TOKEN = 'tkn' // unchanged
    await expect(settle(openHttpD1(OPTS).prepare('SELECT 1').first())).rejects.toThrow(/10000: Authentication error/)
    expect(calls).toHaveLength(1)
  })

  // An empty string is not "look elsewhere" — `??` only falls through on
  // null/undefined — so this is the deterministic no-credential case on any
  // machine, logged into wrangler or not. It must refuse at construction and
  // name the fix, not send `Bearer ` and report a puzzling 401 an hour later.
  it('refuses to be constructed with an empty credential', () => {
    expect(() => openHttpD1({ accountId: 'a', databaseId: 'b', apiToken: '' })).toThrow(/no Cloudflare credential.*wrangler login/s)
  })
})

/* ───────────────────────────── error shaping ───────────────────────────── */

describe('what the caller is told when it goes wrong', () => {
  // Cloudflare serves an HTML error page for some edge failures. JSON.parse
  // throws on it, and the throw must still name the status rather than
  // exploding somewhere unrelated with "Unexpected token <".
  it('turns a non-JSON error page into a clean throw carrying the status', async () => {
    const calls = plan({ kind: 'reply', status: 400, body: '<html><head><title>400 Bad Request</title></head></html>' })
    await expect(settle(openHttpD1(OPTS).prepare('SELECT 1 FROM blobs').first())).rejects.toThrow(/httpD1: query failed — HTTP 400/)
    expect(calls, 'a 400 is the caller’s fault; retrying it five times helps nobody').toHaveLength(1)
  })

  it('names the SQL that failed, truncated, so a batch failure is findable', async () => {
    plan({ kind: 'reply', status: 200, body: '{"success":false,"errors":[{"code":7500,"message":"no such table: blobs"}]}' })
    await expect(settle(openHttpD1(OPTS).prepare('SELECT value FROM blobs WHERE store = ?1').first())).rejects.toThrow(/7500: no such table: blobs[\s\S]*sql: SELECT value FROM blobs/)
  })

  it('treats a 200 with success:false as a failure, not as an empty result', async () => {
    plan({ kind: 'reply', status: 200, body: '{"success":false,"errors":[]}' })
    await expect(settle(openHttpD1(OPTS).prepare('SELECT 1').first())).rejects.toThrow(/query failed/)
  })
})

/* ─────────────────────────────── batch ─────────────────────────────── */

describe('batch', () => {
  // There is no transaction over HTTP and the client does not pretend there is.
  it('runs the statements sequentially and returns one result each', async () => {
    const calls = plan(rows([], { changes: 1 }))
    const db = openHttpD1(OPTS)
    const out = await settle(db.batch!([db.prepare('INSERT 1').bind('a'), db.prepare('INSERT 2').bind('b')]))
    expect(out).toHaveLength(2)
    expect(out.every(r => r.meta?.changes === 1)).toBe(true)
    expect(calls.map(c => JSON.parse(c.body).sql)).toEqual(['INSERT 1', 'INSERT 2'])
  })
})
