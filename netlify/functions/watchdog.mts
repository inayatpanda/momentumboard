import { blobAppStore } from './lib/store'
import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

// THE WATCHDOG: fail-soft everywhere means fail-SILENT everywhere — this is
// the one component whose job is to make noise. Runs weekday mornings after
// the paper should have published and checks the vital signs; a Telegram
// message goes out ONLY when something is wrong. Manual GET with the admin
// token returns the full check table as JSON (no Telegram) for inspection.

const londonDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

async function runChecks(nowSec: number, report: { at: number } | null): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const today = londonDate(nowSec)
  const day = new Date(nowSec * 1000).getUTCDay()
  const weekday = day >= 1 && day <= 5
  // London and NY are both still on the same calendar day at this hour (see
  // report-kick), so `today` doubles as the NY date the holiday calendar needs.
  // A holiday is a non-trading day exactly like a weekend: report-kick never
  // ran predict-background, so the board/scorecard are EXPECTED to be stale.
  const tradingDay = weekday && !isUsMarketHoliday(today)
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const board = await blobAppStore.read<{ date: string; board: unknown[] }>('engine-board').catch(() => null)
  add('engine board', !tradingDay || board?.date === today, board ? `dated ${board.date}, ${board.board?.length ?? 0} live calls` : 'missing')

  add('morning paper', !!report && londonDate(report.at) === today, report ? `published ${londonDate(report.at)}` : 'missing')

  const runlog = ((await blobAppStore.read<{ at: number; kind?: string }[]>('runlog').catch(() => null)) ?? [])
  const lastAlert = runlog.filter(r => !r.kind || r.kind === 'alert-check').slice(-1)[0] ?? runlog.slice(-1)[0]
  add('alert checker', !!lastAlert && nowSec - lastAlert.at < 1800, lastAlert ? `last ran ${Math.round((nowSec - lastAlert.at) / 60)}min ago` : 'no runs logged')
  // NOT the runlog (its read-modify-writes race with alert-check and lose
  // entries) — the scorecard's updatedAt is written by every predict run.
  const scorecard = await blobAppStore.read<{ updatedAt?: number }>('engine-scorecard').catch(() => null)
  const predictedToday = !!scorecard?.updatedAt && londonDate(scorecard.updatedAt) === today
  add('predict run', !tradingDay || predictedToday, scorecard?.updatedAt ? `scorecard updated ${londonDate(scorecard.updatedAt)}` : 'never')

  const { cachedCandles } = await import('./lib/marketCache')
  const spy = await cachedCandles('SPY').catch(() => null)
  const lastBarAge = spy?.length ? (nowSec - spy[spy.length - 1].t) / 86_400 : null
  add('market data (SPY candles)', !!spy && lastBarAge != null && lastBarAge < 5, spy ? `${spy.length} bars, last ${lastBarAge?.toFixed(1)}d old` : 'unfetchable — Yahoo AND Stooq down')

  add('email delivery configured', !!process.env.RESEND_API_KEY && !!process.env.REPORT_EMAIL_TO, process.env.RESEND_API_KEY ? `to ${process.env.REPORT_EMAIL_TO}` : 'RESEND_API_KEY missing')
  add('LLM configured', !!process.env.GROQ_API_KEY || !!process.env.GEMINI_API_KEY || !!process.env.ANTHROPIC_API_KEY, 'at least one provider key present')
  // Groq is the primary; it decommissions Llama models aggressively. Probe the
  // pinned model once a day so a retirement pages HERE (fix = set GROQ_MODEL to
  // the replacement) instead of silently failing the paper over to slower
  // Gemini. Only a genuine model-gone verdict fails the check; transient blips
  // don't. If the paper already fell back, the alert says so.
  const { probeGroqModel } = await import('./lib/llm')
  const groq = await probeGroqModel().catch(() => ({ status: 'transient' as const, model: '?', detail: 'probe crashed' }))
  add('groq primary model', groq.status !== 'retired', groq.status === 'retired' ? `RETIRED — ${groq.detail}. Set GROQ_MODEL to a live model (e.g. meta-llama/llama-4-scout-17b-16e-instruct).` : groq.detail)

  const book = await blobAppStore.read<{ month: string; history: { date: string }[] }>('paper-book').catch(() => null)
  add('paper book', !tradingDay || (!!book && book.history[book.history.length - 1]?.date === today), book ? `last marked ${book.history[book.history.length - 1]?.date ?? 'never'}` : 'missing')

  return checks
}


// SELF-HEAL: the morning report is the one artifact readers actually see —
// if report-kick's 05:20 UTC chain fell over upstream (predict-background
// threw before it could chain to the composer, or the composer itself
// failed), the paper just silently doesn't publish. Past the time it should
// exist, on a weekday, with today's report missing or dated wrong: re-fire
// the composer once. Guarded by a same-day marker so a still-broken composer
// can't get re-kicked every 15 minutes for the rest of the morning.
async function maybeRekick(nowSec: number, today: string, weekday: boolean, report: { at: number } | null): Promise<string> {
  try {
    // report-kick runs 05:20 UTC; give the predict → compose chain a little
    // room before declaring the report missing/stale.
    const pastKickTime = nowSec % 86_400 >= 6 * 3600
    if (!weekday || !pastKickTime) return 'not due'
    const fresh = !!report && londonDate(report.at) === today
    if (fresh) return 'report fresh'

    const marker = await blobAppStore.read<{ date: string }>('watchdog-rekick').catch(() => null)
    if (marker?.date === today) return 'already re-kicked today'

    await blobAppStore.write('watchdog-rekick', { date: today, at: nowSec }).catch(() => {})
    // enqueue for the Actions worker (≤15 min pickup) — the composer no longer
    // runs on Netlify, so the old HTTP re-kick would just 404
    const q = (await blobAppStore.read<unknown[]>('work-queue').catch(() => null)) ?? []
    q.push({ id: crypto.randomUUID(), kind: 'compose', body: null, at: nowSec, attempts: 0 })
    await blobAppStore.write('work-queue', q.slice(-100)).catch(() => {})
    return 'RE-KICKED (queued for the Actions worker)'
  } catch {
    return 'rekick check failed'
  }
}

export default async (req: Request) => {
  const body = await req.text().catch(() => '')
  const scheduled = body.includes('next_run')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!scheduled && !admin) return new Response('forbidden', { status: 401 })

  const nowSec = Math.floor(Date.now() / 1000)
  const today = londonDate(nowSec)
  const day = new Date(nowSec * 1000).getUTCDay()
  const weekday = day >= 1 && day <= 5
  const report = await blobAppStore.read<{ at: number }>('morning-report').catch(() => null)
  const checks = await runChecks(nowSec, report)
  const failures = checks.filter(c => !c.ok)

  const rekick = scheduled ? await maybeRekick(nowSec, today, weekday, report) : 'skipped (manual check)'

  if (scheduled && failures.length && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const { sendTelegram } = await import('./lib/telegram')
    const msg = `WATCHDOG — ${failures.length} problem(s) this morning:\n${failures.map(f => `✗ ${f.name}: ${f.detail}`).join('\n')}\n\nHealthy: ${checks.filter(c => c.ok).map(c => c.name).join(', ') || 'none'}\n\nMorning report re-kick: ${rekick}`
    await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, msg).catch(() => {})
  }
  return new Response(JSON.stringify({ ok: failures.length === 0, checks, rekick }, null, 1), { headers: { 'content-type': 'application/json' } })
}

// 07:15 UTC weekdays = after the 05:20 predict → compose chain has finished
export const config = { schedule: '15 7 * * 1-5' }
