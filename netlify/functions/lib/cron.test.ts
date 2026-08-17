import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './d1Store'
import { CRON_JOBS, CRON_ORIGIN, SWEEP_TRIGGER, TRIGGERS, cronJobUrl, cronMatches, dispatchCron, jobsDueFor, nextRun, synthesiseCronRequest, type CronJob } from './cron'
import { claimScheduleSlot } from './schedule'
import { memoryStore } from './store'
import { useBlobStore, useD1Store } from './storeProvider'
import { clearRuntimeEnv } from './runtimeEnv'
import { FN_PREFIX, dispatch } from './router'

const FUNCTIONS_DIR = join(__dirname, '..')
const src = (name: string) => readFileSync(join(FUNCTIONS_DIR, `${name}.mts`), 'utf8')
const at = (iso: string) => new Date(iso)

describe('cronMatches', () => {
  it('handles every field form the job table uses', () => {
    // 2026-08-13 is a Thursday.
    expect(cronMatches('*/5 * * * *', at('2026-08-13T09:05:00Z'))).toBe(true)
    expect(cronMatches('*/5 * * * *', at('2026-08-13T09:06:00Z'))).toBe(false)
    expect(cronMatches('45 12 * * 1-5', at('2026-08-13T12:45:00Z'))).toBe(true)
    expect(cronMatches('45 12 * * 1-5', at('2026-08-15T12:45:00Z'))).toBe(false) // Saturday
    expect(cronMatches('10 6,18 * * 1-5', at('2026-08-13T18:10:00Z'))).toBe(true)
    expect(cronMatches('10 6,18 * * 1-5', at('2026-08-13T12:10:00Z'))).toBe(false)
    expect(cronMatches('0 8 * * 0', at('2026-08-16T08:00:00Z'))).toBe(true) // Sunday
    expect(cronMatches('0 8 * * 0', at('2026-08-13T08:00:00Z'))).toBe(false)
    expect(cronMatches('20 5 * * 1-5', at('2026-08-13T05:20:00Z'))).toBe(true)
  })

  it('is minute-exact, not hour-wide', () => {
    expect(cronMatches('20 5 * * 1-5', at('2026-08-13T05:21:00Z'))).toBe(false)
    expect(cronMatches('*/15 * * * *', at('2026-08-13T09:30:00Z'))).toBe(true)
    expect(cronMatches('*/15 * * * *', at('2026-08-13T09:31:00Z'))).toBe(false)
  })

  it('refuses malformed expressions instead of matching everything', () => {
    for (const bad of ['', '* * * *', '* * * * * *', 'x * * * *', '*/0 * * * *']) expect(cronMatches(bad, at('2026-08-13T09:05:00Z')), bad).toBe(false)
  })
})

describe('nextRun', () => {
  it('finds the next slot, never the current one', () => {
    expect(nextRun('*/5 * * * *', at('2026-08-13T09:05:00Z'))!.toISOString()).toBe('2026-08-13T09:10:00.000Z')
    expect(nextRun('20 5 * * 1-5', at('2026-08-14T09:00:00Z'))!.toISOString()).toBe('2026-08-17T05:20:00.000Z') // Fri → Mon
  })

  it('gives up rather than spinning on an expression that never fires', () => {
    expect(nextRun('0 0 30 2 *', at('2026-08-13T09:00:00Z'))).toBeNull() // 30 February
  })

  // M-1: it is a schedule-analysis helper and a test instrument, NOT part of
  // building a request. Nothing reads the value of `next_run`; see below.
  it('is not on the request-synthesis path', () => {
    expect(readFileSync(join(__dirname, 'cron.ts'), 'utf8')).not.toMatch(/next_run:[^\n]*nextRun\(|const next = nextRun\(/)
  })
})

describe('the job table', () => {
  const scheduledOnDisk = readdirSync(FUNCTIONS_DIR)
    .filter(f => f.endsWith('.mts'))
    .filter(f => /^export const config[^=]*=\s*\{\s*schedule:/m.test(readFileSync(join(FUNCTIONS_DIR, f), 'utf8')))
    .map(f => f.replace(/\.mts$/, ''))
    .sort()

  it('carries every scheduled function Netlify runs', () => {
    expect(scheduledOnDisk).toEqual(['alert-check', 'alert-tail', 'bulletin-evening', 'bulletin-premarket', 'congress-warm', 'ledger-snapshot', 'watchdog'])
    for (const name of scheduledOnDisk) expect(CRON_JOBS.some(j => j.name === name), name).toBe(true)
  })

  // The cadence a job runs at is the thing a reader notices. EVERY scheduled
  // job keeps Netlify's exact expression — there is no cadence delta in the
  // migration. The watchdog is in this group on purpose: `*/15` was tried and
  // reverted, because watchdog.mts's 'morning paper' check has no tradingDay
  // guard and would page ~78 times a week on a healthy system.
  it("keeps each job's Netlify schedule verbatim", () => {
    const declared = (name: string) => /export const config[^=]*=\s*\{\s*schedule:\s*'([^']+)'/.exec(src(name))?.[1]
    for (const job of CRON_JOBS) {
      if (job.name === 'predict-background') continue // no `export const config` — Netlify never scheduled it
      expect(job.schedule, job.name).toBe(declared(job.name))
    }
    expect(declared('watchdog')).toBe('15 7 * * 1-5')
  })

  // The revert only works because minute 15 is a */15 minute. If someone ever
  // moves the watchdog to :07, the trigger sleeps through it and the check
  // silently never runs — 'never schedules a job on a minute its trigger cannot
  // reach' below would catch it, but say it here too, where the number lives.
  it('wakes for the watchdog on its own trigger', () => {
    const watchdog = CRON_JOBS.find(j => j.name === 'watchdog')!
    expect(watchdog.schedule).toBe('15 7 * * 1-5')
    expect(watchdog.trigger).toBe('*/15 * * * *')
    expect(cronMatches(watchdog.trigger, at('2026-08-10T07:15:00Z'))).toBe(true)
  })

  it('only ever asks for a trigger wrangler.toml actually declares', () => {
    const toml = readFileSync(join(FUNCTIONS_DIR, '..', '..', 'workers', 'cron', 'wrangler.toml'), 'utf8')
    for (const trigger of TRIGGERS) expect(toml).toContain(`"${trigger}"`)
    for (const job of CRON_JOBS) expect(TRIGGERS as readonly string[], job.name).toContain(job.trigger)
  })

  // The whole reason the */5 trigger can carry five jobs.
  it('never schedules a job on a minute its trigger cannot reach', () => {
    for (const job of CRON_JOBS) {
      let reachable = false
      // walk a full week of the job's own schedule and confirm the trigger is awake for each
      let cursor = at('2026-08-09T00:00:00Z')
      for (let i = 0; i < 40; i++) {
        const fire = nextRun(job.schedule, cursor)
        if (!fire) break
        expect(cronMatches(job.trigger, fire), `${job.name} fires at ${fire.toISOString()} but its trigger sleeps`).toBe(true)
        reachable = true
        cursor = fire
      }
      expect(reachable, job.name).toBe(true)
    }
  })

  it('runs the expensive engine only when explicitly switched on', () => {
    const predict = CRON_JOBS.find(j => j.name === 'predict-background')!
    expect(predict.auth).toBe('admin')
    expect(predict.enabled!()).toBe(false) // WORKER_OWNS_PREDICT unset
  })
})

describe('jobsDueFor', () => {
  it('wakes only what is due at that minute', () => {
    expect(jobsDueFor('*/5 * * * *', at('2026-08-13T09:05:00Z')).map(j => j.name)).toEqual(['alert-check'])
    expect(jobsDueFor('*/5 * * * *', at('2026-08-13T12:45:00Z')).map(j => j.name)).toEqual(['alert-check', 'bulletin-premarket'])
    expect(jobsDueFor('*/5 * * * *', at('2026-08-13T18:10:00Z')).map(j => j.name)).toEqual(['alert-check', 'congress-warm'])
    expect(jobsDueFor('*/5 * * * *', at('2026-08-16T08:00:00Z')).map(j => j.name)).toEqual(['alert-check', 'ledger-snapshot'])
    // the tail rides every quarter hour; the watchdog rides one of them
    expect(jobsDueFor('*/15 * * * *', at('2026-08-13T07:15:00Z')).map(j => j.name)).toEqual(['alert-tail', 'watchdog'])
    expect(jobsDueFor('20 5 * * 1-5', at('2026-08-13T05:20:00Z')).map(j => j.name)).toEqual(['predict-background'])
  })

  // The revert, from the dispatcher's side. The */15 trigger still wakes four
  // times an hour (it also sweeps the cache), but the watchdog rides it exactly
  // once a weekday morning — not 168 times a week, of which ~78 would fire on a
  // healthy system because the 'morning paper' check has no tradingDay guard.
  it('does not run the watchdog on every quarter hour', () => {
    for (const t of ['2026-08-13T09:15:00Z', '2026-08-13T07:30:00Z', '2026-08-13T00:15:00Z', '2026-08-15T07:15:00Z' /* Saturday */]) {
      // alert-tail is the quarter-hour job; the watchdog is not one of them
      expect(jobsDueFor('*/15 * * * *', at(t)).map(j => j.name), t).toEqual(['alert-tail'])
    }
  })

  it('does not let one trigger poach another trigger&apos;s jobs', () => {
    expect(jobsDueFor('*/15 * * * *', at('2026-08-13T07:15:00Z')).map(j => j.name)).not.toContain('alert-check')
  })
})

/* ─────────────────────── THE AUTH SYNTHESIS — the gate itself ───────────────────────
 * These read the handlers' OWN gate lines out of the source. If a handler ever
 * changes the marker it greps for, its slot name, or its window, the assertions
 * below fail — they are not a copy of the gate, they are the gate.
 */

// The marker each handler greps its body for. Two spellings live in the tree —
// alert-check tests `body.includes(…)` inline, watchdog binds it to `scheduled`
// first — so the marker is extracted on its own and the refusal is matched
// separately, rather than assuming one line shape.
const GATE_MARKER = /body\.includes\('([^']+)'\)/
const GATE_REFUSAL = /if \(!admin && !.+\) return new Response\('forbidden', \{ status: 401 \}\)/
const GATE_ADMIN = /const admin = req\.headers\.get\('x-app-token'\) === process\.env\.APP_TOKEN/
const GATE_SLOT = /claimScheduleSlot\('([a-z-]+)', ([\d_]+), admin\)/

const cronBodyJobs = CRON_JOBS.filter(j => j.auth === 'cron-body')

describe("the dispatcher's synthesised request passes each handler's real gate", () => {
  it.each(cronBodyJobs.map(j => [j.name, j] as const))('%s', (name, job: CronJob) => {
    const text = src(name)
    const marker = GATE_MARKER.exec(text)?.[1]
    expect(marker, `${name}: body marker not found — the regex or the handler moved`).toBeTruthy()
    expect(GATE_REFUSAL.test(text), `${name}: the !admin refusal not found`).toBe(true)
    // `req?.headers?.get` in two files; normalise before matching the one shape.
    expect(GATE_ADMIN.test(text.replace(/req\?\./g, 'req.').replace(/headers\?\./g, 'headers.')), `${name}: admin check not found`).toBe(true)

    const req = synthesiseCronRequest(job, { at: at('2026-08-13T09:05:00Z') })
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${CRON_ORIGIN}/${name}`)
    // …AND NO ADMIN TOKEN. `admin` bypasses claimScheduleSlot, so sending one
    // would silently delete the only rate bound these public URLs have.
    expect(req.headers.get('x-app-token')).toBeNull()
    return req.text().then(body => {
      // The body the handler greps for — Netlify's scheduler shape, verbatim.
      expect(body).toContain(marker!)
      expect(JSON.parse(body)).toEqual({ next_run: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
    })
  })

  it('hands the admin token to predict-background, the one job with no body-marker door', async () => {
    const predict = CRON_JOBS.find(j => j.name === 'predict-background')!
    expect(GATE_MARKER.test(src('predict-background'))).toBe(false)
    expect(src('predict-background')).toContain("auth?.level !== 'admin'")
    const req = synthesiseCronRequest(predict, { at: at('2026-08-13T05:20:00Z'), appToken: 'sekrit' })
    expect(req.headers.get('x-app-token')).toBe('sekrit')
    expect(await req.text()).toContain('next_run')
  })

  // M-1. `next_run` is a MARKER, not data: every handler does
  // `body.includes('next_run')` and not one of them parses the value (the
  // grep is the whole story). Computing it used to walk the schedule minute by
  // minute — up to 10,080 iterations for a weekly job — to fill a field nobody
  // reads. One minute on is honest, constant-time, and equally unread.
  it('stamps next_run a minute out instead of scanning the schedule for it', async () => {
    const sunday = CRON_JOBS.find(j => j.name === 'ledger-snapshot')! // '0 8 * * 0' — days away on a Thursday
    const now = at('2026-08-13T09:05:00Z')
    const body = JSON.parse(await synthesiseCronRequest(sunday, { at: now }).text())
    expect(body.next_run).toBe(new Date(now.getTime() + 60_000).toISOString())
    for (const name of readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.mts'))) {
      expect(readFileSync(join(FUNCTIONS_DIR, name), 'utf8'), `${name} reads next_run's VALUE — the constant is no longer safe`).not.toMatch(/next_run['"]?\s*\]|\.next_run/)
    }
  })

  it('refuses to run an admin job with no token rather than firing one that will 401', () => {
    const predict = CRON_JOBS.find(j => j.name === 'predict-background')!
    expect(() => synthesiseCronRequest(predict, { at: at('2026-08-13T05:20:00Z'), appToken: '' })).toThrow(/APP_TOKEN/)
  })

  // The bound the handlers rely on, driven with each job's OWN window, through
  // the real claimScheduleSlot. Not sending the admin token is what keeps this true.
  it('leaves every slot window enforced, exactly as on Netlify', async () => {
    for (const job of cronBodyJobs) {
      const m = GATE_SLOT.exec(src(job.name))
      expect(m, `${job.name}: claimScheduleSlot call not found`).toBeTruthy()
      const [, slot, windowRaw] = m!
      const windowSec = Number(windowRaw.replace(/_/g, ''))
      expect(slot).toBe(job.name)
      const store = memoryStore()
      const t = 1_760_000_000
      expect(await claimScheduleSlot(slot, windowSec, false, store, t), `${job.name} first tick`).toBe(true)
      expect(await claimScheduleSlot(slot, windowSec, false, store, t + 1), `${job.name} replay`).toBe(false)
      expect(await claimScheduleSlot(slot, windowSec, false, store, t + windowSec), `${job.name} next window`).toBe(true)
      // …and admin (which the dispatcher never sends) would have skipped all of it
      expect(await claimScheduleSlot(slot, windowSec, true, store, t + windowSec + 1)).toBe(true)
    }
  })
})

describe('dispatchCron', () => {
  beforeEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })
  afterEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })

  it('runs due jobs in order, isolates a failure, and reports both', async () => {
    const seen: string[] = []
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T12:45:00Z'), {
      run: async job => {
        seen.push(job.name)
        if (job.name === 'alert-check') throw new Error('boom')
        return new Response('ok')
      },
    })
    expect(seen).toEqual(['alert-check', 'bulletin-premarket'])
    expect(results[0]).toMatchObject({ job: 'alert-check', error: 'boom' })
    expect(results[1]).toMatchObject({ job: 'bulletin-premarket', status: 200, body: 'ok' })
  })

  it('skips a disabled job with a reason instead of running it', async () => {
    const results = await dispatchCron('20 5 * * 1-5', at('2026-08-13T05:20:00Z'), { run: async () => new Response('should not run') })
    expect(results).toEqual([{ job: 'predict-background', ran: false, skipped: 'disabled' }])
  })

  it('sweeps expired cache rows on the quarter-hour tick — M1 wrote sweepExpired, this calls it', async () => {
    const swept: number[] = []
    const results = await dispatchCron(SWEEP_TRIGGER, at('2026-08-13T09:15:00Z'), {
      run: async () => new Response('ok'),
      sweep: async limit => {
        swept.push(limit)
        return 1688
      },
    })
    expect(swept).toEqual([1000])
    expect(results.find(r => r.job === 'cache-sweep')).toMatchObject({ ran: true, body: 'removed 1688' })
  })

  it('does not sweep on the other triggers', async () => {
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'), { run: async () => new Response('ok') })
    expect(results.map(r => r.job)).not.toContain('cache-sweep')
  })

  it('reports the sweep as skipped when Blobs owns the cache', async () => {
    const results = await dispatchCron(SWEEP_TRIGGER, at('2026-08-13T09:15:00Z'), { run: async () => new Response('ok') })
    expect(results.find(r => r.job === 'cache-sweep')).toMatchObject({ ran: false, skipped: 'no d1 cache store' })
  })
})

/* ───────────────────────── C-1: one invocation per job ─────────────────────────
 * The free plan gives 50 subrequests per INVOCATION, and every fetch and every
 * D1 binding call spends one. Running the tick's jobs in-process shared that
 * budget between them, so at 12:45 bulletin-premarket inherited whatever
 * alert-check had left. The dispatcher now POSTs each job to its own
 * `/api/fn/<name>` door: a fresh budget per job, one subrequest per job here.
 */
describe('the dispatcher gives each job its own invocation', () => {
  const BASE = 'https://streetsignal.pages.dev'
  beforeEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })
  afterEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })

  const capture = () => {
    const sent: { url: string; method: string; token: string | null; body: string; trigger: string | null }[] = []
    const fetch = async (req: Request) => {
      sent.push({ url: req.url, method: req.method, token: req.headers.get('x-app-token'), body: await req.text(), trigger: req.headers.get('x-cron-trigger') })
      return new Response('ok')
    }
    return { sent, fetch }
  }

  it('POSTs every due job to its own by-name door on the Pages origin', async () => {
    const { sent, fetch } = capture()
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T12:45:00Z'), { baseUrl: BASE, fetch })
    expect(sent.map(s => s.url)).toEqual([`${BASE}${FN_PREFIX}alert-check`, `${BASE}${FN_PREFIX}bulletin-premarket`])
    expect(sent.every(s => s.method === 'POST')).toBe(true)
    expect(results.map(r => r.job)).toEqual(['alert-check', 'bulletin-premarket'])
    expect(results.every(r => r.ran && r.status === 200 && r.body === 'ok')).toBe(true)
  })

  // The whole point of the by-name door is that it is the SAME request the
  // in-process path built — including the missing token. `admin` bypasses
  // claimScheduleSlot, so a dispatcher that started sending one over HTTP would
  // quietly delete the only rate bound these public URLs have.
  it('sends the synthesised scheduler body and NO admin token', async () => {
    const { sent, fetch } = capture()
    await dispatchCron('*/5 * * * *', at('2026-08-13T12:45:00Z'), { baseUrl: BASE, fetch, appToken: 'sekrit' })
    for (const s of sent) {
      expect(s.token).toBeNull()
      expect(s.body).not.toContain('sekrit')
      expect(JSON.parse(s.body)).toEqual({ next_run: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
      expect(s.trigger).toBe('*/5 * * * *')
    }
  })

  it('builds the door from the router constant, trailing slash or not', () => {
    const job = CRON_JOBS.find(j => j.name === 'watchdog')!
    expect(cronJobUrl(BASE, job)).toBe(`${BASE}/api/fn/watchdog`)
    expect(cronJobUrl(`${BASE}/`, job)).toBe(`${BASE}/api/fn/watchdog`)
  })

  it('reads the origin off the environment when none is injected', async () => {
    const { sent, fetch } = capture()
    await dispatchCron('*/15 * * * *', at('2026-08-13T07:15:00Z'), { fetch, sweep: async () => 0, jobs: CRON_JOBS.filter(j => j.name === 'watchdog') })
    expect(sent).toEqual([]) // no URL anywhere → nothing is posted…
    process.env.URL = BASE
    try {
      await dispatchCron('*/15 * * * *', at('2026-08-13T07:15:00Z'), { fetch, sweep: async () => 0, jobs: CRON_JOBS.filter(j => j.name === 'watchdog') })
      expect(sent.map(s => s.url)).toEqual([`${BASE}${FN_PREFIX}watchdog`])
    } finally {
      delete process.env.URL
    }
  })

  it('reports a missing origin as a job error rather than silently skipping the tick', async () => {
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'), { fetch: async () => new Response('ok') })
    expect(results[0]).toMatchObject({ job: 'alert-check', ran: true })
    expect(results[0].error).toMatch(/URL/)
  })

  // Netlify gave each of these its own invocation and nobody ever saw its
  // status. This log is now the only place a 500 from a bulletin surfaces.
  it('reports a non-2xx as a job error, keeping the status and the body head', async () => {
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T12:45:00Z'), {
      baseUrl: BASE,
      fetch: async req => (req.url.endsWith('alert-check') ? new Response('boom: no such table blobs', { status: 500 }) : new Response('ok')),
    })
    expect(results[0]).toMatchObject({ job: 'alert-check', ran: true, status: 500, body: 'boom: no such table blobs', error: 'HTTP 500: boom: no such table blobs' })
    expect(results[1]).toMatchObject({ job: 'bulletin-premarket', status: 200 })
    expect(results[1].error).toBeUndefined()
  })

  it('isolates a transport failure to the one job, exactly as a thrown handler was', async () => {
    const results = await dispatchCron('*/5 * * * *', at('2026-08-13T12:45:00Z'), {
      baseUrl: BASE,
      fetch: async req => {
        if (req.url.endsWith('alert-check')) throw new Error('fetch failed')
        return new Response('ok')
      },
    })
    expect(results[0]).toMatchObject({ job: 'alert-check', ran: true, error: 'fetch failed' })
    expect(results[1]).toMatchObject({ job: 'bulletin-premarket', status: 200 })
  })

  // ONE subrequest per job is the entire budget the dispatcher spends. If this
  // ever counts more than the number of due jobs, the fix has been undone.
  it('spends exactly one subrequest per due job', async () => {
    const { sent, fetch } = capture()
    await dispatchCron('*/5 * * * *', at('2026-08-16T08:00:00Z'), { baseUrl: BASE, fetch }) // Sunday: alert-check + ledger-snapshot
    expect(sent).toHaveLength(2)
  })

  // The one job that carries APP_TOKEN never goes over the public door: the
  // site's master credential would be on the wire every 05:20 tick for nothing.
  it('keeps predict-background in-process, so APP_TOKEN never goes on the wire', async () => {
    const { sent, fetch } = capture()
    const predict = { ...CRON_JOBS.find(j => j.name === 'predict-background')!, enabled: () => true }
    // No `run` override: this takes the DEFAULT admin path. APP_TOKEN is unset
    // in the environment, so the real handler's own authenticate() refuses —
    // which is the proof that the real handler is what ran, right here.
    const results = await dispatchCron('20 5 * * 1-5', at('2026-08-13T05:20:00Z'), { jobs: [predict], baseUrl: BASE, fetch, appToken: 'sekrit' })
    expect(sent).toEqual([]) // nothing on the wire
    expect(results[0]).toMatchObject({ job: 'predict-background', ran: true, status: 401, body: 'admin-only' })
  })
})

// The whole chain with nothing stubbed: a Cloudflare cron tick → the
// synthesised POST → the REAL Pages router (resolveRoute, the D1 binding) →
// alert-check.mts's ACTUAL gate → the real claimScheduleSlot → a real D1 store.
// It reaches 'no-config' because the store is empty, which is a line the
// handler only gets to AFTER passing both doors.
describe('end to end, on D1', () => {
  beforeEach(() => clearRuntimeEnv())
  afterEach(() => {
    clearRuntimeEnv()
    useBlobStore()
  })

  it('drives the real alert-check handler and is throttled on the replay', async () => {
    const db = openSqliteD1(':memory:')
    await ensureD1Schema(db)
    useD1Store(db)
    // The other half of the C-1 fix, exercised for real: the dispatcher's fetch
    // is answered by the same `dispatch()` a Pages Function calls, handed the
    // same binding a Pages invocation would be handed.
    const fetch = async (req: Request) => (await dispatch(req, { env: { STREETSIGNAL_DB: db } }))!
    const opts = { baseUrl: 'https://streetsignal.pages.dev', fetch }

    const first = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'), opts)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ job: 'alert-check', ran: true, status: 200, body: 'no-config' })

    // The slot was claimed in D1 by the run above, so the immediate replay —
    // the exact thing an attacker replaying `next_run` would do — is refused.
    const replay = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'), opts)
    expect(replay[0]).toMatchObject({ job: 'alert-check', status: 429, body: 'throttled', error: 'HTTP 429: throttled' })

    const runlog = await db.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = 'runlog'`).first<{ value: string }>()
    expect(JSON.parse(runlog!.value)[0]).toMatchObject({ errors: ['no-config'] })
    db.close()
  })
})
