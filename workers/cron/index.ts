// THE CRON WORKER — three triggers, the same handlers the website runs.
//
// M2 of the Cloudflare migration (docs/superpowers/specs/2026-08-12-cloudflare-migration-design.md).
//
// Deployed to `*.workers.dev`, so it needs no custom domain (the reason it is a
// separate Worker from the Pages project at all: Pages Functions cannot carry
// cron triggers). It shares the D1 binding with Pages.
//
// It does NOT run the jobs itself. Each due job is POSTed to its own
// `/api/fn/<name>` door on the Pages origin (`URL`), so it executes in its own
// Pages Functions invocation with its own 50-subrequest budget — the C-1 fix;
// see `dispatchCron`'s comment for why a shared budget silently degraded every
// job after the first. This Worker therefore spends one subrequest per job, and
// still needs the D1 binding only for the quarter-hour cache sweep.
//
// Everything interesting is in `lib/cron.ts`: the job table, the cron matcher,
// and the synthesis of the `{"next_run": …}` body each handler's own gate
// expects. Read that file's header for why the dispatcher deliberately does NOT
// send an admin token.

import { installRuntimeEnv, readEnv, type RuntimeEnvBag } from '../../netlify/functions/lib/runtimeEnv'
import { configureStoreFromEnv, storeBackend } from '../../netlify/functions/lib/storeProvider'
import { dispatchCron, jobsDueFor, CRON_JOBS, TRIGGERS } from '../../netlify/functions/lib/cron'

/** Structural stand-in for Cloudflare's `ScheduledController` / `ExecutionContext`
 * — declared locally so M2 adds no `@cloudflare/workers-types` dependency, the
 * same call M1 made for `D1Database`. */
interface ScheduledController {
  cron: string
  scheduledTime: number
  noRetry?(): void
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

function boot(env: RuntimeEnvBag): void {
  installRuntimeEnv(env)
  configureStoreFromEnv(env)
}

export default {
  async scheduled(controller: ScheduledController, env: RuntimeEnvBag, ctx: ExecutionContext): Promise<void> {
    boot(env)
    const at = new Date(controller.scheduledTime)
    const due = jobsDueFor(controller.cron, at)
    console.log(`CRON ${controller.cron} @ ${at.toISOString()} — store=${storeBackend()} due=[${due.map(j => j.name).join(', ') || 'none'}]`)

    // Awaited, not backgrounded: the platform keeps the invocation alive for the
    // whole of `scheduled()`, and a floating promise here would be killed the
    // moment this function returned — which is how a cron silently does nothing.
    const results = await dispatchCron(controller.cron, at)
    for (const r of results) console.log(`CRON  ${r.job}: ${r.error ? `ERROR ${r.error}` : r.skipped ? `skipped (${r.skipped})` : `${r.status} ${r.body ?? ''}`}${r.ms != null ? ` (${r.ms}ms)` : ''}`)
    void ctx
  },

  /** MANUAL TRIGGER, admin only. M3's gate is "all crons observed firing", and
   * waiting up to a working week for `20 5 * * 1-5` to come round is not a test
   * plan. Requires the same `x-app-token` every admin endpoint on the site
   * requires; without APP_TOKEN set it refuses outright rather than opening. */
  async fetch(request: Request, env: RuntimeEnvBag): Promise<Response> {
    boot(env)
    const url = new URL(request.url)
    const token = readEnv('APP_TOKEN')
    if (!token || request.headers.get('x-app-token') !== token) return new Response('forbidden', { status: 401 })

    if (url.pathname === '/jobs') {
      return Response.json({
        store: storeBackend(),
        triggers: TRIGGERS,
        jobs: CRON_JOBS.map(j => ({ name: j.name, schedule: j.schedule, trigger: j.trigger, auth: j.auth, enabled: j.enabled ? j.enabled() : true, why: j.why })),
      })
    }

    if (url.pathname === '/run') {
      const cron = url.searchParams.get('cron')
      if (!cron) return new Response('pass ?cron=<expression>, one of: ' + TRIGGERS.join(' | '), { status: 400 })
      const atParam = url.searchParams.get('at')
      const at = atParam ? new Date(atParam) : new Date()
      if (Number.isNaN(at.getTime())) return new Response('bad ?at', { status: 400 })
      return Response.json({ cron, at: at.toISOString(), results: await dispatchCron(cron, at) })
    }

    return new Response('streetsignal-cron: /jobs | /run?cron=…&at=…', { status: 404 })
  },
}
