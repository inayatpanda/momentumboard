// THE SCHEDULED DISPATCHER — Cloudflare cron triggers, the existing handlers.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// Netlify's scheduler POSTs each scheduled function a JSON body carrying
// `next_run` and nothing else — no signature, no shared secret (the audit's
// C-1). The handlers therefore do NOT trust that body as authentication: they
// use it only to reject casual traffic, and then BOUND whatever gets through
// with `claimScheduleSlot`, a once-per-window claim recorded in the store.
// alert-check.mts:22-26 is the canonical shape:
//
//     const body = await req.text()
//     const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
//     if (!admin && !body.includes('next_run')) return 401
//     if (!(await claimScheduleSlot('alert-check', 240, admin))) return 429
//
// SO THE SYNTHESIS IS: a POST whose body is `{"next_run": "<ISO>"}` and
// DELIBERATELY NO `x-app-token`.
//
// Withholding the admin token is the whole point. `admin` bypasses the window
// claim, so a dispatcher that sent it would turn every cron tick into an
// unbounded run and quietly delete the only protection those public URLs have.
// Cloudflare's `scheduled()` cannot be reached from the internet at all, so the
// dispatcher needs no privilege — it just has to look like the scheduler, which
// is precisely what `next_run` means to these handlers. The result is that a
// job's real cadence is still enforced by its own slot window, on both hosts,
// by the same code.
//
// The one exception is declared, not accidental: predict-background has NO
// body-marker path (it requires `level === 'admin'`), because it is the
// expensive one. It is marked `auth: 'admin'` in the table below and is the
// only job the dispatcher hands a token to.
//
// WHY A JOB TABLE AND ONLY THREE TRIGGERS. The design fixes three cron
// expressions on the Worker (§2). Netlify had seven scheduled functions. Every
// one of the other four fires on a minute divisible by five (12:45, 16:05,
// 06:10/18:10, 08:00), so the `*/5` trigger can carry them at their EXACT
// Netlify cadence: the trigger wakes the Worker, and `cronMatches` decides which
// jobs are actually due. That keeps the wrangler.toml to the three the design
// names, stays inside Cloudflare's five-trigger free-plan limit, and leaves each
// job's schedule written down in one readable place.

import { readEnv } from './runtimeEnv'
import { currentCacheStore } from './storeProvider'
import { invokeHandler, type HandlerName } from './router'

/* ───────────────────────────── cron matching ─────────────────────────────
 * Enough of the syntax for the expressions this project actually uses:
 * a star, a star with a step, `a`, `a-b`, `a-b/n`, and comma lists of those.
 * (The literal forms are not written out here: a star followed by a slash ends
 * a block comment.) Day-of-week is
 * 0-6 with 0 = Sunday, matching both Netlify and Cloudflare. Everything is UTC
 * — Cloudflare cron triggers are UTC and so were Netlify's.
 */

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
]

function matchField(spec: string, value: number, [lo, hi]: [number, number]): boolean {
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1) return false
    let from: number
    let to: number
    if (range === '*') {
      from = lo
      to = hi
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return false
      from = a
      to = b
    } else {
      const n = Number(range)
      if (!Number.isInteger(n)) return false
      // A bare number with a step means "from n to the end of the field".
      from = n
      to = stepRaw ? hi : n
    }
    if (value < from || value > to) continue
    if ((value - from) % step === 0) return true
  }
  return false
}

/** Does `expr` fire at this instant (to the minute, UTC)? */
export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const values = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()]
  // Standard cron day-of-month / day-of-week OR-semantics are deliberately NOT
  // implemented: no expression here restricts both, and guessing would be worse
  // than a plain AND that every one of our schedules satisfies.
  return fields.every((f, i) => matchField(f, values[i], FIELD_RANGES[i]))
}

/** The next instant after `after` at which `expr` fires, scanning minute by
 * minute. Bounded to eight days so a nonsense expression cannot spin. */
export function nextRun(expr: string, after: Date, limitMinutes = 8 * 24 * 60): Date | null {
  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000)
  for (let i = 1; i <= limitMinutes; i++) {
    const candidate = new Date(t.getTime() + i * 60_000)
    if (cronMatches(expr, candidate)) return candidate
  }
  return null
}

/* ──────────────────────────────── the jobs ──────────────────────────────── */

export type CronAuth = 'cron-body' | 'admin'

export interface CronJob {
  /** The handler file this job runs. */
  name: HandlerName
  /** WHEN it runs — the cadence Netlify used, kept verbatim. */
  schedule: string
  /** WHICH wrangler trigger wakes the Worker for it. */
  trigger: string
  auth: CronAuth
  /** Off by default → skipped with a reason instead of run. */
  enabled?: () => boolean
  why: string
}

/** The three cron expressions declared in workers/cron/wrangler.toml. */
export const TRIGGERS = ['*/5 * * * *', '*/15 * * * *', '20 5 * * 1-5'] as const
export type Trigger = (typeof TRIGGERS)[number]

export const CRON_JOBS: readonly CronJob[] = [
  { name: 'alert-check', schedule: '*/5 * * * *', trigger: '*/5 * * * *', auth: 'cron-body', why: 'the alert loop — its own 240s slot window bounds it' },
  { name: 'bulletin-premarket', schedule: '45 12 * * 1-5', trigger: '*/5 * * * *', auth: 'cron-body', why: '~45 min before the US open' },
  { name: 'bulletin-evening', schedule: '5 16 * * 1-5', trigger: '*/5 * * * *', auth: 'cron-body', why: 'the LSE-close wrap' },
  { name: 'congress-warm', schedule: '10 6,18 * * 1-5', trigger: '*/5 * * * *', auth: 'cron-body', why: 'disclosure sweep on the server clock' },
  { name: 'ledger-snapshot', schedule: '0 8 * * 0', trigger: '*/5 * * * *', auth: 'cron-body', why: 'Sunday track-record email' },
  {
    name: 'watchdog',
    schedule: '*/15 * * * *',
    trigger: '*/15 * * * *',
    auth: 'cron-body',
    why: "the design's cadence; the handler's own 3600s slot claim collapses it to hourly, and only a FAILING check speaks",
  },
  {
    name: 'predict-background',
    schedule: '20 5 * * 1-5',
    trigger: '20 5 * * 1-5',
    auth: 'admin',
    // Design §2: buildBoard's maths over ~180 names will exceed the free tier's
    // 10ms CPU budget, so the brain lives in GitHub Actions. The slot exists so
    // M3 can MEASURE that claim behind a switch instead of assuming it.
    enabled: () => readEnv('WORKER_OWNS_PREDICT') === '1',
    why: 'the morning engine run — owned by GitHub Actions unless WORKER_OWNS_PREDICT=1',
  },
]

/** M1 left `sweepExpired` written, tested and uncalled. This calls it: the
 * cache rows Netlify used to reclaim for free are now ours to clear, and the
 * quarter-hour tick is the cheapest place to do it. No-op under Blobs. */
export const SWEEP_TRIGGER: Trigger = '*/15 * * * *'
export const SWEEP_LIMIT = 1000

/* ─────────────────────────── the synthesised call ─────────────────────────── */

/** The URL a synthesised request carries. Never fetched — the dispatcher calls
 * the handler function directly — but handlers build `new URL(req.url)`, so it
 * has to be a real absolute URL. */
export const CRON_ORIGIN = 'https://cron.streetsignal.internal'

export interface SynthOptions {
  at: Date
  /** Only supplied for `auth: 'admin'` jobs. */
  appToken?: string
}

/** Build the request a handler's own gate will accept. See the header for why
 * `x-app-token` is absent from every cron-body job. */
export function synthesiseCronRequest(job: CronJob, opts: SynthOptions): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Not a credential and not read by any handler — a breadcrumb for the logs
    // so a run's origin is legible in M3's parallel diff.
    'x-cron-trigger': job.trigger,
    'user-agent': 'StreetSignal-Cron/1.0 (cloudflare-scheduled)',
  }
  if (job.auth === 'admin') {
    const token = opts.appToken ?? readEnv('APP_TOKEN')
    if (!token) throw new Error(`cron job ${job.name} needs APP_TOKEN and none is set`)
    headers['x-app-token'] = token
  }
  const next = nextRun(job.schedule, opts.at)
  return new Request(`${CRON_ORIGIN}/${job.name}`, {
    method: 'POST',
    headers,
    // The exact shape Netlify's scheduler sends. `next_run` is what every
    // scheduled handler greps the body for.
    body: JSON.stringify({ next_run: (next ?? new Date(opts.at.getTime() + 60_000)).toISOString() }),
  })
}

/* ──────────────────────────────── dispatch ──────────────────────────────── */

export interface CronResult {
  job: string
  ran: boolean
  status?: number
  body?: string
  skipped?: string
  error?: string
  ms?: number
}

/** Which jobs a given trigger owns at a given minute. */
export function jobsDueFor(trigger: string, at: Date, jobs: readonly CronJob[] = CRON_JOBS): CronJob[] {
  return jobs.filter(j => j.trigger === trigger && cronMatches(j.schedule, at))
}

export interface DispatchCronOptions {
  jobs?: readonly CronJob[]
  /** Injected for tests; production calls the real handler loader. */
  run?: (job: CronJob, req: Request) => Promise<Response>
  appToken?: string
  /** Injected for tests; production sweeps the live cache store. */
  sweep?: (limit: number) => Promise<number>
}

/**
 * Run everything this trigger owns at this minute, in order, and report.
 *
 * SEQUENTIAL ON PURPOSE. These jobs read-modify-write the same `runlog` blob,
 * and running them concurrently would lose entries the same way alert-check and
 * predict-background used to race (see watchdog.mts:35). They are also
 * individually failure-isolated: one job throwing must not stop the rest of the
 * tick, exactly as Netlify's independent invocations behaved.
 */
export async function dispatchCron(trigger: string, at: Date = new Date(), opts: DispatchCronOptions = {}): Promise<CronResult[]> {
  const jobs = opts.jobs ?? CRON_JOBS
  const run = opts.run ?? ((job: CronJob, req: Request) => invokeHandler(job.name, req))
  const results: CronResult[] = []

  for (const job of jobsDueFor(trigger, at, jobs)) {
    if (job.enabled && !job.enabled()) {
      results.push({ job: job.name, ran: false, skipped: 'disabled' })
      continue
    }
    const started = Date.now()
    try {
      const res = await run(job, synthesiseCronRequest(job, { at, appToken: opts.appToken }))
      results.push({ job: job.name, ran: true, status: res.status, body: (await res.text().catch(() => '')).slice(0, 200), ms: Date.now() - started })
    } catch (e) {
      results.push({ job: job.name, ran: true, error: String((e as Error)?.message ?? e).slice(0, 300), ms: Date.now() - started })
    }
  }

  if (trigger === SWEEP_TRIGGER) {
    const sweep = opts.sweep ?? (async (limit: number) => (await currentCacheStore()?.sweepExpired(limit)) ?? -1)
    try {
      const removed = await sweep(SWEEP_LIMIT)
      if (removed >= 0) results.push({ job: 'cache-sweep', ran: true, status: 200, body: `removed ${removed}` })
      else results.push({ job: 'cache-sweep', ran: false, skipped: 'no d1 cache store' })
    } catch (e) {
      results.push({ job: 'cache-sweep', ran: true, error: String((e as Error)?.message ?? e).slice(0, 200) })
    }
  }

  return results
}
