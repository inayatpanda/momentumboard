import type { AppStore } from './store'
import type { Prediction } from '../../../shared/engine/types'

// THE BULLETINS: two intraday dispatches that bookend the morning paper.
//   premarket (~45min before the US open): futures, VIX and the world tape →
//     the expected open direction, said plainly, with what would invalidate it.
//   evening (~5pm UK): how the day actually went — the board's calls marked to
//     market — and what to look out for tomorrow (econ prints, earnings, levels).
// Everything is gathered fail-soft; if the LLM is down the deterministic text
// still publishes. Delivery = Telegram + email + the app's Reports archive.

export type BulletinKind = 'premarket' | 'evening'

export interface Bulletin {
  kind: BulletinKind
  date: string // London date
  at: number
  subject: string
  text: string // telegram-friendly plain text
  html: string // email/archive page
}

const londonDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const pct = (x: number | null | undefined) => (x == null ? '?' : `${x >= 0 ? '+' : ''}${Math.round(x * 10) / 10}%`)

export async function composeBulletin(kind: BulletinKind, store: AppStore, env: { FINNHUB_API_KEY?: string }, nowSec: number): Promise<Bulletin> {
  const date = londonDate(nowSec)
  const grab = async <T,>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null)

  const { defaultDeps, fetchMediaTitles } = await import('./engine')
  const deps = defaultDeps({ FINNHUB_API_KEY: env.FINNHUB_API_KEY })
  const { worldTone, newsTone, VIX_SYMBOL } = await import('../../../shared/engine/worldTape')

  const [worldReads, titles, board, econ] = await Promise.all([
    grab(() => deps.worldReads()),
    grab(() => fetchMediaTitles()),
    grab(() => store.read<{ date: string; regime: string; board: Prediction[] }>('engine-board')),
    grab(async () => {
      const { parseEconFeed } = await import('./econCalendar')
      const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
      return parseEconFeed((await res.json()) as never)
    }),
  ])

  const vix = worldReads?.find(r => r.sym === VIX_SYMBOL.sym)
  const futures = (worldReads ?? []).filter(r => r.sym === 'ES=F' || r.sym === 'NQ=F')
  const europeAsia = (worldReads ?? []).filter(r => r.sym !== VIX_SYMBOL.sym && r.sym !== 'ES=F' && r.sym !== 'NQ=F')
  const tone = worldReads ? worldTone(worldReads.filter(r => r.sym !== VIX_SYMBOL.sym), vix?.changePct ?? null) : null
  const news = titles?.length ? newsTone(titles) : null

  // the board's live calls, marked to the current tape (evening) or listed (premarket)
  const live = (board?.board ?? []).filter(b => !b.shadow).slice(0, 8)
  const marked = await Promise.all(
    live.map(async p => {
      const { cachedQuote } = await import('./marketCache')
      const q = await grab(() => cachedQuote(p.sym, env.FINNHUB_API_KEY ?? ''))
      const movePct = q?.price && p.entry ? Math.round(((q.price - p.entry) / p.entry) * (p.side === 'short' ? -1000 : 1000)) / 10 : null
      return { sym: p.sym, side: p.side, grade: p.grade, entry: p.entry, stop: p.stop, target: p.target, movePct }
    }),
  )

  const horizonEnd = kind === 'premarket' ? nowSec + 12 * 3600 : nowSec + 30 * 3600
  const events = (econ ?? []).filter(e => e.at > nowSec && e.at < horizonEnd).slice(0, 6)

  const dataLines = [
    futures.length ? `Futures: ${futures.map(f => `${f.name} ${pct(f.changePct)}`).join(', ')}` : null,
    vix ? `VIX ${pct(vix.changePct)} on the day` : null,
    europeAsia.length ? `World tape: ${europeAsia.map(r => `${r.name} ${pct(r.changePct)}`).join(', ')}${tone ? ` → ${tone.tone}` : ''}` : null,
    news ? `Headlines lean ${news.label} (${news.hits} scored)` : null,
    board ? `Board (${board.date}, regime ${board.regime}): ${marked.map(m => `${m.sym} ${m.side}${m.movePct != null ? ` ${pct(m.movePct)} since entry` : ''}`).join('; ') || 'no live calls'}` : null,
    events.length ? `Calendar: ${events.map(e => `${e.title} (${e.country} ${e.impact})`).join('; ')}` : null,
  ].filter(Boolean) as string[]

  const ask =
    kind === 'premarket'
      ? `Write a PRE-MARKET brief (4-6 sentences). Lead with the expected US open direction, stated plainly from the futures and world tape above, and say what would invalidate that read within the first hour. Mention the VIX only if it matters today. If the board has live calls, one sentence on how the open affects their entries/stops. End with the single most important thing to watch this session.`
      : `Write an EVENING wrap (5-7 sentences). First: how the session actually went, using the world tape and the board's marked-to-market calls above — credit hits and own misses plainly. Then TOMORROW: what to expect and look out for — tomorrow's calendar prints above, and the board levels that matter (stops close to price, targets in reach). End with the one thing the reader should check first tomorrow morning.`

  let prose: string | null = null
  try {
    const { callLlm } = await import('./llm')
    const { text } = await callLlm(
      `You are The Street Signal's desk. Today is ${date} (${kind === 'premarket' ? 'before the US open' : 'after the London close'}).\n\nMeasured data (do not invent numbers):\n- ${dataLines.join('\n- ')}\n\n${ask}\nPlain, specific, no hedging filler. End with one short "analysis, not advice" note.`,
      { maxTokens: 700 },
    )
    prose = text.trim()
  } catch {
    /* deterministic fallback below */
  }

  const title = kind === 'premarket' ? 'Pre-market brief' : 'Evening wrap — and tomorrow'
  const subject = `The Street Signal — ${title.toLowerCase()}, ${new Date(nowSec * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}`
  const bodyText = prose ?? `${title} (auto-summary — the desk's writer was unavailable):\n\n${dataLines.join('\n')}`
  const text = `${kind === 'premarket' ? '🌅' : '🌆'} ${title} — ${date}\n\n${bodyText}\n\nFull app → https://thestreetsignal.netlify.app`

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;background:#0a0b0e;color:#eceff4;font-family:-apple-system,system-ui,sans-serif;line-height:1.6">
<div style="max-width:640px;margin:0 auto;padding:28px 20px">
<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:2px">StreetSignal</div>
<div style="color:#98a2b3;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:18px">${title} · ${date}</div>
<div style="font-size:15px;white-space:pre-wrap">${bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
<div style="margin-top:20px;padding-top:14px;border-top:1px solid rgba(158,173,198,.2);color:#636e80;font-size:12px">
${dataLines.map(l => `<div style="margin-bottom:4px">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('')}
<div style="margin-top:12px"><a href="https://thestreetsignal.netlify.app" style="color:#5aa9ff">Open the app</a> · analysis, not advice</div>
</div></div></body></html>`

  return { kind, date, at: nowSec, subject, text, html }
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
  const { sendReportEmail } = await import('./email')
  await sendReportEmail(
    { RESEND_API_KEY: process.env.RESEND_API_KEY, REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO, REPORT_EMAIL_FROM: process.env.REPORT_EMAIL_FROM },
    b.subject,
    b.html,
  ).catch(() => {})

  const runlog = (await store.read<unknown[]>('runlog')) ?? []
  runlog.push({ at: nowSec, kind: `bulletin-${kind}` })
  await store.write('runlog', runlog.slice(-200))
  return b
}
