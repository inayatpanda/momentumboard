import type { AppStore } from './store'
import type { Prediction } from '../../../shared/engine/types'
import type { AppConfig } from '../../../shared/config'

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

  const [worldReads, titles, board, paperBook, econ] = await Promise.all([
    grab(() => deps.worldReads()),
    grab(() => fetchMediaTitles()),
    grab(() => store.read<{ date: string; regime: string; board: Prediction[] }>('engine-board')),
    grab(() => store.read<{ month: string; startGBP: number; positions: unknown[]; closed: { plGBP: number }[]; history: { date: string; equity: number }[] }>('paper-book')),
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

  // the board's actionable calls, marked to the current tape (evening) or
  // listed (premarket) — watch-only entries stay off the bulletin
  const live = (board?.board ?? []).filter(b => !b.shadow && !b.watchOnly).slice(0, 12)
  const marked = await Promise.all(
    live.map(async p => {
      const { cachedQuote } = await import('./marketCache')
      const q = await grab(() => cachedQuote(p.sym, env.FINNHUB_API_KEY ?? ''))
      const movePct = q?.price && p.entry ? Math.round(((q.price - p.entry) / p.entry) * (p.side === 'short' ? -1000 : 1000)) / 10 : null
      return { sym: p.sym, side: p.side, grade: p.grade, entry: p.entry, now: q?.price ?? null, stop: p.stop, target: p.target, movePct, note: p.note }
    }),
  )

  // the day's tape extremes ride the evening edition (10-min movers cache)
  const movers =
    kind === 'evening'
      ? await grab(async () => {
          const { getCached } = await import('./cache')
          return getCached<{ gainers: { sym: string; changePct: number | null; stage: string | null }[]; losers: { sym: string; changePct: number | null; stage: string | null }[] }>('movers')
        })
      : null

  const horizonEnd = kind === 'premarket' ? nowSec + 12 * 3600 : nowSec + 30 * 3600
  const events = (econ ?? []).filter(e => e.at > nowSec && e.at < horizonEnd).slice(0, 8)

  const dataLines = [
    futures.length ? `Futures: ${futures.map(f => `${f.name} ${pct(f.changePct)}`).join(', ')}` : null,
    vix ? `VIX ${pct(vix.changePct)} on the day` : null,
    europeAsia.length ? `World tape: ${europeAsia.map(r => `${r.name} ${pct(r.changePct)}`).join(', ')}${tone ? ` → ${tone.tone}` : ''}` : null,
    news ? `Headlines lean ${news.label} (${news.hits} scored)` : null,
    board ? `Board (${board.date}, regime ${board.regime}): ${marked.map(m => `${m.sym} ${m.side}${m.movePct != null ? ` ${pct(m.movePct)} since entry` : ''}`).join('; ') || 'no live calls'}` : null,
    events.length ? `Calendar: ${events.map(e => `${e.title} (${e.country} ${e.impact})`).join('; ')}` : null,
    paperBook && paperBook.history.length
      ? (() => {
          const eq = paperBook.history[paperBook.history.length - 1].equity
          const ret = Math.round(((eq - paperBook.startGBP) / paperBook.startGBP) * 1000) / 10
          return `The mock £10k book (${paperBook.month}): equity £${Math.round(eq)}, ${ret >= 0 ? '+' : ''}${ret}% this month, ${paperBook.positions.length} open, ${paperBook.closed.length} closed`
        })()
      : null,
  ].filter(Boolean) as string[]

  const ask =
    kind === 'premarket'
      ? `Write a PRE-MARKET brief as THREE titled sections, each 3-5 full sentences:
THE OPEN — the expected US open direction, stated plainly from the futures and world tape, with the size of the move implied and what would invalidate the read in the first hour.
THE BOARD — how the expected open affects each live call's entry, stop and target; name the calls closest to their levels.
THE WATCH — today's calendar prints with their risk, the VIX if it matters, and the single most important thing to watch this session.`
      : `Write an EVENING report as THREE titled sections, each 3-5 full sentences:
THE SESSION — how the day actually went across the world tape and the board's marked-to-market calls; credit hits and own misses plainly, with the numbers.
TOMORROW — what to expect and look out for: the calendar prints listed above and what each could move, plus which board stops and targets are within reach of current prices.
FIRST CHECK — the one thing to look at first tomorrow morning, and why.`

  let prose: string | null = null
  try {
    const { callLlm } = await import('./llm')
    const { text } = await callLlm(
      `You are The Street Signal's desk. Today is ${date} (${kind === 'premarket' ? 'before the US open' : 'after the London close'}).\n\nMeasured data (do not invent numbers):\n- ${dataLines.join('\n- ')}\n\n${ask}\nFormat: section title on its own line in CAPITALS, then the paragraph. Plain, specific, no hedging filler. End with one short "analysis, not advice" note.`,
      { maxTokens: 1100 },
    )
    prose = text.trim()
  } catch {
    /* deterministic fallback below */
  }

  const title = kind === 'premarket' ? 'Pre-market brief' : 'Evening report — and tomorrow'
  const subject = `The Street Signal — ${title.toLowerCase()}, ${new Date(nowSec * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}`
  const bodyText = prose ?? `${title} (auto-summary — the desk's writer was unavailable):\n\n${dataLines.join('\n')}`

  // telegram: prose + the board marked to market
  const boardLines = marked.map(m => `${m.sym} ${m.side.toUpperCase()} ${m.grade} · in ${m.entry}${m.now != null ? ` → ${m.now}` : ''}${m.movePct != null ? ` (${pct(m.movePct)})` : ''} · stop ${m.stop} · tgt ${m.target}`)
  const text = `${title.toUpperCase()} — ${date}\n\n${bodyText}${boardLines.length ? `\n\nTHE BOARD\n${boardLines.join('\n')}` : ''}\n\nFull app → https://thestreetsignal.rqai.co.uk/app/`

  // ---- the email/archive page: a structured mini-edition, not a note ----
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const up = (x: number | null) => (x == null ? '#98a2b3' : x >= 0 ? '#2bd396' : '#ff5f76')
  const th = 'text-align:left;color:#636e80;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid rgba(158,173,198,.2)'
  const td = 'padding:6px 8px;border-bottom:1px solid rgba(158,173,198,.12);font-size:13px'
  const num = 'font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums'
  const section = (t: string, inner: string) =>
    `<div style="margin-top:26px"><div style="color:#98a2b3;font-size:11px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;border-bottom:1px solid rgba(158,173,198,.2);padding-bottom:6px;margin-bottom:8px">${t}</div>${inner}</div>`

  const tapeRows = [...futures, ...(vix ? [vix] : []), ...europeAsia]
    .map(r => `<tr><td style="${td}">${esc(r.name)}</td><td style="${td};${num};text-align:right;color:${up(r.changePct)}">${pct(r.changePct)}</td></tr>`)
    .join('')
  const tapeHtml = tapeRows
    ? section('The tape' + (tone ? ` · ${esc(tone.tone)}` : ''), `<table style="width:100%;border-collapse:collapse">${tapeRows}</table>`)
    : ''

  const boardRows = marked
    .map(
      m => `<tr>
<td style="${td};font-weight:700">${esc(m.sym)}</td>
<td style="${td};color:${m.side === 'long' ? '#2bd396' : '#ff5f76'}">${m.side}</td>
<td style="${td}">${esc(m.grade)}</td>
<td style="${td};${num};text-align:right">${m.entry}</td>
<td style="${td};${num};text-align:right">${m.now ?? '·'}</td>
<td style="${td};${num};text-align:right;color:${up(m.movePct)}">${m.movePct != null ? pct(m.movePct) : '·'}</td>
<td style="${td};${num};text-align:right">${m.stop}</td>
<td style="${td};${num};text-align:right">${m.target}</td></tr>`,
    )
    .join('')
  const boardHtml = marked.length
    ? section(
        `The board · ${board?.date ?? ''} · regime ${board?.regime ?? '?'}`,
        `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:520px"><tr><th style="${th}">Sym</th><th style="${th}">Side</th><th style="${th}">Gr</th><th style="${th};text-align:right">Entry</th><th style="${th};text-align:right">Now</th><th style="${th};text-align:right">Move</th><th style="${th};text-align:right">Stop</th><th style="${th};text-align:right">Target</th></tr>${boardRows}</table></div>`,
      )
    : ''

  const moverLine = (rows: { sym: string; changePct: number | null; stage: string | null }[]) =>
    rows
      .slice(0, 4)
      .map(r => `<span style="margin-right:14px">${esc(r.sym)} <span style="${num};color:${up(r.changePct)}">${pct(r.changePct)}</span>${r.stage ? ` <span style="color:#636e80">${esc(r.stage.replace('-', ' '))}</span>` : ''}</span>`)
      .join('')
  const moversHtml = movers
    ? section('The day\'s extremes', `<div style="font-size:13px;margin-bottom:6px">${moverLine(movers.gainers ?? [])}</div><div style="font-size:13px">${moverLine(movers.losers ?? [])}</div>`)
    : ''

  const calRows = events
    .map(
      e =>
        `<tr><td style="${td};${num}">${new Date(e.at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}</td><td style="${td}">${esc(e.title)}</td><td style="${td}">${esc(e.country)}</td><td style="${td};color:${e.impact === 'High' ? '#f2b843' : '#98a2b3'}">${esc(e.impact)}</td></tr>`,
    )
    .join('')
  const calHtml = events.length
    ? section(kind === 'premarket' ? 'Today\'s calendar (UK time)' : 'Tomorrow\'s calendar (UK time)', `<table style="width:100%;border-collapse:collapse">${calRows}</table>`)
    : ''

  const proseHtml = esc(bodyText)
    .split(/\n{2,}/)
    .map(p => {
      const m = p.match(/^([A-Z][A-Z '&—-]{2,40})\n([\s\S]*)$/)
      if (m) return `<div style="margin-top:18px"><div style="font-family:Georgia,serif;font-size:16px;color:#d0a75e;margin-bottom:4px">${m[1].trim()}</div><div style="font-size:15px">${m[2].trim()}</div></div>`
      return `<div style="font-size:15px;margin-top:12px">${p.trim()}</div>`
    })
    .join('')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;background:#0a0b0e;color:#eceff4;font-family:-apple-system,system-ui,sans-serif;line-height:1.6">
<div style="max-width:640px;margin:0 auto;padding:28px 20px">
<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:2px">StreetSignal</div>
<div style="color:#98a2b3;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">${title} · ${new Date(nowSec * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}</div>
${news ? `<div style="color:#636e80;font-size:12px">Headlines lean ${esc(news.label)}</div>` : ''}
${proseHtml}
${tapeHtml}
${boardHtml}
${paperBook && paperBook.history.length ? `<div style="margin-top:10px;color:#98a2b3;font-size:13px">The mock £10k book: <span style="${num}">£${Math.round(paperBook.history[paperBook.history.length - 1].equity)}</span> · ${paperBook.positions.length} open · ${paperBook.closed.length} closed this month</div>` : ''}
${moversHtml}
${calHtml}
<div style="margin-top:26px;padding-top:14px;border-top:1px solid rgba(158,173,198,.2);color:#636e80;font-size:12px">
<a href="https://thestreetsignal.rqai.co.uk/app/" style="color:#5aa9ff">Open the app</a> · <a href="https://thestreetsignal.rqai.co.uk/report" style="color:#5aa9ff">this morning's paper</a> · analysis, not advice
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
  const cfg = await store.read<AppConfig>('config').catch(() => null)
  await sendReportEmail(
    { RESEND_API_KEY: process.env.RESEND_API_KEY, REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO, REPORT_EMAIL_FROM: process.env.REPORT_EMAIL_FROM },
    b.subject,
    b.html,
    fetch,
    undefined,
    cfg?.reportRecipients,
  ).catch(() => {})

  const runlog = (await store.read<unknown[]>('runlog')) ?? []
  runlog.push({ at: nowSec, kind: `bulletin-${kind}` })
  await store.write('runlog', runlog.slice(-200))
  return b
}
