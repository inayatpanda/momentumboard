import type { AppStore } from './store'
import { loadDailyBrief } from './dailyBrief'
const WILDCARD_MARK = 'Experimental:'
import type { AppConfig } from '../../../shared/config'

// THE BULLETINS: two intraday dispatches that bookend the morning paper.
//   premarket (~45min before the US open): futures, VIX and the world tape →
//     the expected open direction, said plainly, with what would invalidate it.
//   evening (~5pm UK): how the day actually went — the board's calls marked to
//     market — and what to look out for tomorrow (econ prints, earnings, levels).
// Evidence is gathered fail-soft and summarised without another LLM call. Delivery = Telegram + email + the app's Reports archive.

export type BulletinKind = 'premarket' | 'evening'

export interface Bulletin {
  kind: BulletinKind
  date: string // London date
  at: number
  subject: string
  text: string // telegram-friendly plain text
  html: string // email/archive page
}

const pct = (x: number | null | undefined) => (x == null ? '?' : `${x >= 0 ? '+' : ''}${Math.round(x * 10) / 10}%`)

// ---- the mini-edition's shared bits (hoisted so the two board-row templates
// below can be pure, exported and tested without running the whole compose) ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const up = (x: number | null) => (x == null ? '#98a2b3' : x >= 0 ? '#2bd396' : '#ff5f76')
const numStyle = 'font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums'

/** One board row as both dispatches print it: the call, marked to the current
 * tape. `wildcard` is the EXPERIMENT SLOT's flag (Stage 3d) — a quarter-size row
 * on a trade the engine's own gates refused. */
export interface BulletinBoardMark {
  sym: string
  side: 'long' | 'short'
  grade: string
  entry: number
  now: number | null
  stop: number
  target: number
  movePct: number | null
  wildcard?: boolean
}

/** THE TELEGRAM LINE. Pure + exported for the same reason the paper's board
 * projection is (newspaper.ts): this is a surface the reader is SENT, and a row
 * kind that goes unmarked here reaches them as an ordinary call. */
export function bulletinBoardLine(m: BulletinBoardMark): string {
  return `${m.wildcard ? `${WILDCARD_MARK} ` : ''}${m.sym} ${m.side.toUpperCase()} ${m.grade} · in ${m.entry}${m.now != null ? ` → ${m.now}` : ''}${
    m.movePct != null ? ` (${pct(m.movePct)})` : ''
  } · stop ${m.stop} · tgt ${m.target}`
}

/** THE EMAIL ROW — stacked two-line rows, not a grid: eight columns can never fit
 * a phone inbox, and mail apps have no inner scrolling (Gmail strips overflow — a
 * sideways swipe just turns the page to the next email). Line one is the call and
 * its mark-to-market; line two carries the levels. The mark sits beside the
 * ticker, where the app's own board card puts it. */
export function bulletinBoardRowHtml(m: BulletinBoardMark): string {
  return `<tr>
<td style="padding:8px 8px 0;font-size:13.5px">${m.wildcard ? `${WILDCARD_MARK} ` : ''}<b>${esc(m.sym)}</b> <span style="color:${m.side === 'long' ? '#2bd396' : '#ff5f76'}">${m.side}</span> <span style="color:#98a2b3">· ${esc(m.grade)}</span></td>
<td style="padding:8px 8px 0;${numStyle};text-align:right;color:${up(m.movePct)}">${m.movePct != null ? pct(m.movePct) : '·'}</td></tr>
<tr><td colspan="2" style="padding:2px 8px 8px;border-bottom:1px solid rgba(158,173,198,.12);${numStyle};font-size:12px;color:#98a2b3">in ${m.entry}${m.now != null ? ` → ${m.now}` : ''} · stop ${m.stop} · tgt ${m.target}</td></tr>`
}

export async function composeBulletin(kind: BulletinKind, store: AppStore, env: { FINNHUB_API_KEY?: string }, nowSec: number): Promise<Bulletin> {
  const { cachedQuote } = await import('./marketCache')
  const { parseEconFeed } = await import('./econCalendar')
  const [quotes, calendar] = await Promise.all([
    Promise.all(['SPY', 'QQQ'].map(sym => cachedQuote(sym, env.FINNHUB_API_KEY ?? '').catch(() => null))),
    fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { signal: AbortSignal.timeout(8000) })
      .then(async res => res.ok ? parseEconFeed(await res.json()) : []).catch(() => []),
  ])
  // Reuse the engine's evidence. No extra LLM calls and no invented forecast of
  // the opening direction or of a US session that has not closed yet.
  const market = quotes.flatMap((q, i) => q ? [{ name: i === 0 ? 'US shares (SPY)' : 'Nasdaq 100 (QQQ)', changePct: q.changePct, asOf: q.asOf, stale: q.stale }] : [])
  const brief = await loadDailyBrief(store, kind, nowSec, calendar, market)
  return { kind, date: brief.date, at: nowSec, subject: brief.subject, text: brief.text, html: brief.html }
}

/** Compose → archive → deliver. Every stage fail-soft; the archive write is
 * the only one that must succeed for the run to count. */
export async function publishBulletin(kind: BulletinKind, store: AppStore): Promise<Bulletin> {
  const nowSec = Math.floor(Date.now() / 1000)
  const b = await composeBulletin(kind, store, { FINNHUB_API_KEY: process.env.FINNHUB_API_KEY }, nowSec)

  const dayKey = `bulletins:${b.date}`
  const day = ((await store.read<Bulletin[]>(dayKey)) ?? []).filter(x => x.kind !== kind)
  day.push(b)
  await store.write(dayKey, day)
  const index = ((await store.read<{ date: string; kind: BulletinKind }[]>('bulletin-index')) ?? []).filter(e => !(e.date === b.date && e.kind === kind))
  index.push({ date: b.date, kind })
  index.sort((a, z) => a.date.localeCompare(z.date))
  await store.write('bulletin-index', index.slice(-180))

  const { sendTelegram } = await import('./telegram')
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, b.text).catch(() => {})
  }
  const { sendReportEmail, recipientsForEdition } = await import('./email')
  const cfg = await store.read<AppConfig>('config').catch(() => null)
  await sendReportEmail(
    { RESEND_API_KEY: process.env.RESEND_API_KEY, REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO, REPORT_EMAIL_FROM: process.env.REPORT_EMAIL_FROM },
    b.subject,
    b.html,
    fetch,
    undefined,
    // each bulletin is its own edition — recipients pick which of the three
    // daily sends (morning paper / pre-market / evening) they receive
    recipientsForEdition(kind, cfg?.reportRecipients),
  ).catch(() => {})

  const runlog = (await store.read<unknown[]>('runlog')) ?? []
  runlog.push({ at: nowSec, kind: `bulletin-${kind}` })
  await store.write('runlog', runlog.slice(-200))
  return b
}
