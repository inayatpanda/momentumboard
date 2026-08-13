import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteD1 } from '../../../scripts/lib/sqliteD1'
import { ensureD1Schema } from './d1Store'
import { CRON_JOBS, CRON_ORIGIN, SWEEP_TRIGGER, TRIGGERS, cronMatches, dispatchCron, jobsDueFor, nextRun, synthesiseCronRequest, type CronJob } from './cron'
import { claimScheduleSlot } from './schedule'
import { memoryStore } from './store'
import { useBlobStore, useD1Store } from './storeProvider'
import { clearRuntimeEnv } from './runtimeEnv'

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
})

describe('the job table', () => {
  const scheduledOnDisk = readdirSync(FUNCTIONS_DIR)
    .filter(f => f.endsWith('.mts'))
    .filter(f => /^export const config[^=]*=\s*\{\s*schedule:/m.test(readFileSync(join(FUNCTIONS_DIR, f), 'utf8')))
    .map(f => f.replace(/\.mts$/, ''))
    .sort()

  it('carries every scheduled function Netlify runs', () => {
    expect(scheduledOnDisk).toEqual(['alert-check', 'bulletin-evening', 'bulletin-premarket', 'congress-warm', 'ledger-snapshot', 'watchdog'])
    for (const name of scheduledOnDisk) expect(CRON_JOBS.some(j => j.name === name), name).toBe(true)
  })

  // The cadence a job runs at is the thing a reader notices. Every one except
  // the watchdog keeps Netlify's exact expression, and the watchdog's change is
  // the design's, declared here so it cannot happen by accident.
  it("keeps each job's Netlify schedule verbatim", () => {
    const declared = (name: string) => /export const config[^=]*=\s*\{\s*schedule:\s*'([^']+)'/.exec(src(name))?.[1]
    for (const job of CRON_JOBS) {
      if (job.name === 'watchdog' || job.name === 'predict-background') continue
      expect(job.schedule, job.name).toBe(declared(job.name))
    }
    expect(declared('watchdog')).toBe('15 7 * * 1-5')
    expect(CRON_JOBS.find(j => j.name === 'watchdog')!.schedule).toBe('*/15 * * * *')
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
    expect(jobsDueFor('*/15 * * * *', at('2026-08-13T09:15:00Z')).map(j => j.name)).toEqual(['watchdog'])
    expect(jobsDueFor('20 5 * * 1-5', at('2026-08-13T05:20:00Z')).map(j => j.name)).toEqual(['predict-background'])
  })

  it('does not let one trigger poach another trigger&apos;s jobs', () => {
    expect(jobsDueFor('*/15 * * * *', at('2026-08-13T09:15:00Z')).map(j => j.name)).not.toContain('alert-check')
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

// The whole chain with nothing stubbed: a Cloudflare cron tick → the
// synthesised body → alert-check.mts's ACTUAL gate → the real claimScheduleSlot
// → a real D1 store. It reaches 'no-config' because the store is empty, which
// is a line the handler only gets to AFTER passing both doors.
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

    const first = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'))
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ job: 'alert-check', ran: true, status: 200, body: 'no-config' })

    // The slot was claimed in D1 by the run above, so the immediate replay —
    // the exact thing an attacker replaying `next_run` would do — is refused.
    const replay = await dispatchCron('*/5 * * * *', at('2026-08-13T09:05:00Z'))
    expect(replay[0]).toMatchObject({ job: 'alert-check', status: 429, body: 'throttled' })

    const runlog = await db.prepare(`SELECT value FROM blobs WHERE store = 'app' AND key = 'runlog'`).first<{ value: string }>()
    expect(JSON.parse(runlog!.value)[0]).toMatchObject({ errors: ['no-config'] })
    db.close()
  })
})
