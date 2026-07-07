import { blobAppStore } from './lib/store'

// THE WATCHDOG: fail-soft everywhere means fail-SILENT everywhere — this is
// the one component whose job is to make noise. Runs weekday mornings after
// the paper should have published and checks the vital signs; a Telegram
// message goes out ONLY when something is wrong. Manual GET with the admin
// token returns the full check table as JSON (no Telegram) for inspection.

const londonDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

async function runChecks(nowSec: number): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const today = londonDate(nowSec)
  const day = new Date(nowSec * 1000).getUTCDay()
  const weekday = day >= 1 && day <= 5
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  const board = await blobAppStore.read<{ date: string; board: unknown[] }>('engine-board').catch(() => null)
  add('engine board', !weekday || board?.date === today, board ? `dated ${board.date}, ${board.board?.length ?? 0} live calls` : 'missing')

  const report = await blobAppStore.read<{ at: number }>('morning-report').catch(() => null)
  add('morning paper', !!report && londonDate(report.at) === today, report ? `published ${londonDate(report.at)}` : 'missing')

  const runlog = ((await blobAppStore.read<{ at: number; kind?: string }[]>('runlog').catch(() => null)) ?? [])
  const lastAlert = runlog.filter(r => !r.kind || r.kind === 'alert-check').slice(-1)[0] ?? runlog.slice(-1)[0]
  add('alert checker', !!lastAlert && nowSec - lastAlert.at < 1800, lastAlert ? `last ran ${Math.round((nowSec - lastAlert.at) / 60)}min ago` : 'no runs logged')
  const predictedToday = runlog.some(r => r.kind === 'predict' && londonDate(r.at) === today)
  add('predict run', !weekday || predictedToday, predictedToday ? 'ran today' : 'no run today')

  const { cachedCandles } = await import('./lib/marketCache')
  const spy = await cachedCandles('SPY').catch(() => null)
  const lastBarAge = spy?.length ? (nowSec - spy[spy.length - 1].t) / 86_400 : null
  add('market data (SPY candles)', !!spy && lastBarAge != null && lastBarAge < 5, spy ? `${spy.length} bars, last ${lastBarAge?.toFixed(1)}d old` : 'unfetchable — Yahoo AND Stooq down')

  add('email delivery configured', !!process.env.RESEND_API_KEY && !!process.env.REPORT_EMAIL_TO, process.env.RESEND_API_KEY ? `to ${process.env.REPORT_EMAIL_TO}` : 'RESEND_API_KEY missing')
  add('LLM configured', !!process.env.GROQ_API_KEY || !!process.env.GEMINI_API_KEY || !!process.env.ANTHROPIC_API_KEY, 'at least one provider key present')

  const book = await blobAppStore.read<{ month: string; history: { date: string }[] }>('paper-book').catch(() => null)
  add('paper book', !weekday || (!!book && book.history[book.history.length - 1]?.date === today), book ? `last marked ${book.history[book.history.length - 1]?.date ?? 'never'}` : 'missing')

  return checks
}

export default async (req: Request) => {
  const body = await req.text().catch(() => '')
  const scheduled = body.includes('next_run')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!scheduled && !admin) return new Response('forbidden', { status: 401 })

  const nowSec = Math.floor(Date.now() / 1000)
  const checks = await runChecks(nowSec)
  const failures = checks.filter(c => !c.ok)

  if (scheduled && failures.length && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const { sendTelegram } = await import('./lib/telegram')
    const msg = `WATCHDOG — ${failures.length} problem(s) this morning:\n${failures.map(f => `✗ ${f.name}: ${f.detail}`).join('\n')}\n\nHealthy: ${checks.filter(c => c.ok).map(c => c.name).join(', ') || 'none'}`
    await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, msg).catch(() => {})
  }
  return new Response(JSON.stringify({ ok: failures.length === 0, checks }, null, 1), { headers: { 'content-type': 'application/json' } })
}

// 07:15 UTC weekdays = after the 05:20 predict → compose chain has finished
export const config = { schedule: '15 7 * * 1-5' }
