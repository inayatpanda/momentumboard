import { reportStockLabel } from './reportStockNames'
import type { AppStore } from './store'
import type { StrategyChoicesSnapshot } from '../../../shared/engine/strategyChoices'
import type { StockContext } from '../../../shared/engine/stockContext'
import type { VideoExtract } from './videoTrends'
import type { CalendarRow } from './newspaper'
import { CANONICAL_SITE } from './site'

export type BriefEdition = 'morning' | 'premarket' | 'evening'
export interface BriefSection { title: string; lines: string[]; path: string }
export interface DailyBrief { title: string; date: string; subject: string; sections: BriefSection[]; text: string; html: string }
export interface BriefInputs {
  strategies?: StrategyChoicesSnapshot | null
  contexts?: { generatedAt: number; items: Record<string, StockContext> } | null
  videos?: VideoExtract[] | null
  calendar?: CalendarRow[]
  market?: { name: string; changePct: number | null; asOf: number; stale?: boolean }[]
}
const DAY = 86400
const fresh = (at: number | null | undefined, now: number, days = 2) => Number.isFinite(at) && at! > 0 && at! <= now && now - at! <= days * DAY
const clean = (s: string, limit = 180) => {
  const text = s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  const end = text.slice(0, limit - 1)
  return `${end.slice(0, end.lastIndexOf(' ') > limit / 2 ? end.lastIndexOf(' ') : end.length).replace(/[,;:. ]+$/, '')}…`
}
const sectorName = (sector: string) => ({ XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare', XLI: 'Industrials', XLY: 'Consumer spending', XLP: 'Everyday essentials', XLU: 'Utilities', XLB: 'Materials', XLC: 'Communication services', XLRE: 'Property' } as Record<string, string>)[sector] ?? sector

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const day = (at: number) => new Date(at * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const stamp = (at: number) => new Date(at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })

/** Shared recipients and the public archive must never receive the owner's
 * watchlist, positions or notes. Only shared engine research is loaded here.
 * No provider calls: scheduled briefs reuse existing evidence. */
export async function loadDailyBrief(store: AppStore, edition: BriefEdition, now: number, calendar: CalendarRow[] = [], market: BriefInputs['market'] = []): Promise<DailyBrief> {
  const [strategies, contexts, videos] = await Promise.all([
    store.read<StrategyChoicesSnapshot>('engine-strategy-choices').catch(() => null),
    store.read<BriefInputs['contexts']>('engine-stock-contexts').catch(() => null),
    store.read<VideoExtract[]>('video-extracts').catch(() => null),
  ])
  return buildDailyBrief(edition, now, { strategies, contexts, videos, calendar, market })
}

export function buildDailyBrief(edition: BriefEdition, now: number, input: BriefInputs): DailyBrief {
  const date = day(now)
  const title = { morning: 'Your morning brief', premarket: 'Before the US open', evening: 'Your afternoon update' }[edition]
  const subject = `StreetSignal — ${title.toLowerCase()} · ${date}`
  const sections: BriefSection[] = []
  const add = (title: string, lines: string[], path: string) => sections.push({ title, lines: lines.map(l => clean(l, 220)).slice(0, 3), path })
  if (edition !== 'morning') {
    const quotes = (input.market ?? []).filter(q => !q.stale && fresh(q.asOf, now, 1) && q.changePct != null && Number.isFinite(q.changePct))
    add('Latest market check', quotes.length ? quotes.slice(0, 2).map(q => `${q.name}: ${q.changePct! >= 0 ? '+' : ''}${q.changePct!.toFixed(1)}% versus its previous close; quoted ${stamp(q.asOf)} UK.`) : ['Fresh market quotes are unavailable.'], '/app/today')
  }
  const snapshot = fresh(input.strategies?.generatedAt, now) ? input.strategies : null
  const contexts = fresh(input.contexts?.generatedAt, now) ? Object.values(input.contexts!.items).filter(c => fresh(c.generatedAt, now) && c.changes?.baselineAt && c.changes.baselineAt < c.generatedAt && fresh(c.changes.baselineAt, now, 8)) : []
  const changes = contexts.flatMap(c => (c.changes?.lines ?? []).filter(l => !/No material change|No new completed|tracking has started/.test(l)).slice(0, 1).map(l => {
    const headline = c.news?.find(n => n.collectedAt > c.changes!.baselineAt! && n.collectedAt <= now)
    const line = /newly collected company/.test(l) && headline ? `New headline collected: ${clean(headline.title, 120)}` : l
    return `${reportStockLabel(c.symbol)} (since ${day(c.changes!.baselineAt!)}): ${line}`
  })).sort()
  add('What changed', changes.length ? changes.slice(0, 2) : ['No fresh, comparable changes are available in this summary. Open your stocks for the latest saved checks.'], '/app/stocks')

  const choices: string[] = []
  for (const [key, label] of [['healthy-drop', 'Healthy businesses after a fall'], ['quarterly-recovery', 'Recovery with quarterly checks'], ['sector-leader', 'Sector leaders']] as const) {
    const group = snapshot?.strategies.find(g => g.key === key)
    if (!group) continue
    const matches = (group.status === 'ready' ? group.matches : []).filter(m => m.status === 'matches' && m.side === 'long' && fresh(m.asOf, now, 7)).sort((a, b) => a.symbol.localeCompare(b.symbol))
    choices.push(matches.length ? `${label}: ${matches.slice(0, 2).map(m => `${reportStockLabel(m.symbol, m.name)}${m.sector ? ` (${sectorName(m.sector)})` : ''}`).join(', ')}. ${matches.length} match${matches.length === 1 ? '' : 'es'}.` : `${label}: ${group.status === 'missing-data' ? 'not enough data to check' : 'no current matches in the available data'}.`)
  }
  add('Stocks to research', choices.length ? choices : ['The strategy scan needs a fresh update. Older matches are not presented as today’s choices.'], '/app/stocks?view=strategies')

  const sell = snapshot?.sellReview
  const reviews = fresh(sell?.generatedAt, now) ? sell!.rows.filter(r => r.status === 'review' && r.signals.length && r.signals.every(s => s.evidenceAt <= now)).sort((a, b) => Number(b.signals.some(s => s.kind === 'business')) - Number(a.signals.some(s => s.kind === 'business')) || a.symbol.localeCompare(b.symbol)) : []
  add('If you own these stocks', reviews.length ? [
    ...reviews.slice(0, 2).map(r => `${reportStockLabel(r.symbol, r.name)}: ${r.signals.map(s => clean(s.label, 40)).join('; ')}.${r.gaps.length ? ' Some checks are incomplete.' : ''}`),
  ] : [fresh(sell?.generatedAt, now) ? 'No selling-review warnings in the available checks.' : 'The selling review needs fresh data; no conclusion is drawn from missing checks.'], '/app/stocks?view=sell')

  const seen = new Set<string>()
  const videos = (input.videos ?? []).filter(v => fresh(v.at, now)).sort((a, b) => b.at - a.at).filter(v => { if (seen.has(v.url)) return false; seen.add(v.url); return true }).slice(0, 2)
  add('Newly processed videos', videos.length ? videos.map(v => {
    const claim = v.tickers.find(t => t.thesis && !t.hype)
    const view = claim && /RSI|MACD|divergence|Fibonacci/i.test(claim.thesis!) ? `Chart patterns suggest ${claim.stance === 'bull' ? 'a possible rise' : claim.stance === 'bear' ? 'a possible fall' : 'an uncertain direction'}.` : claim?.thesis
    return `${clean(v.channel, 40)}: ${claim ? `${clean(reportStockLabel(claim.sym, claim.company), 65)} — ${clean(view!, 100)}` : clean(v.title, 75)}`
  }) : ['No newly processed video findings in the last 48 hours. Earlier findings and processing status are in the app.'], '/app/more/street')

  const events = (input.calendar ?? []).filter(e => e.at > now && e.at <= now + 36 * 3600).sort((a, b) => a.at - b.at).slice(0, 2)
  add('What to watch next', events.length ? events.map(e => `${stamp(e.at)} UK — ${e.title} (${e.country}).`) : ['Check upcoming company results before acting. Recheck the business and sector evidence if a stock moves sharply.'], '/app/today')
  const updated = snapshot ? `Strategy scan updated ${stamp(snapshot.generatedAt)} UK. Prices may be from the last completed session.` : 'Strategy data is missing or more than 48 hours old.'
  const note = 'Research, not personal advice. Examples are alphabetical, not ranked. Video summaries may be incomplete or contain errors; check the linked evidence.'
  const reportUrl = `${CANONICAL_SITE}/report?date=${date}`
  // Bounded section counts and line lengths keep this below Telegram's 4096
  // limit without truncating a caveat or cutting the evidence link.
  const text = `${title} · ${date}\nUpdated ${stamp(now)} UK\n\n${sections.map(s => `${s.title}\n${s.lines.join('\n')}`).join('\n\n')}\n\n${updated}\n${note}\n\nSee the evidence: ${CANONICAL_SITE}/app/\nFull report: ${reportUrl}`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;background:#f3f5f8;color:#182230;font-family:Arial,sans-serif;line-height:1.6"><div style="max-width:600px;margin:auto;padding:24px 18px"><div style="font-size:14px;font-weight:700;color:#2563eb">STREETSIGNAL</div><h1 style="font-size:28px;line-height:1.2;margin-bottom:8px">${title}</h1><p style="color:#586579;font-size:13px">${date} · Updated ${stamp(now)} UK<br>About 2 minutes to read</p>${sections.map(s => `<section style="background:#fff;border:1px solid #dfe5ed;border-radius:14px;padding:18px;margin:16px 0"><h2 style="font-size:18px;margin:0 0 10px">${s.title}</h2>${s.lines.map(l => `<p style="font-size:15px;margin:10px 0">${esc(l)}</p>`).join('')}<a style="font-size:14px;color:#1d4ed8" href="${CANONICAL_SITE}${esc(s.path)}">See the evidence →</a></section>`).join('')}<p style="font-size:12px;color:#586579">${esc(updated)}<br>${note}</p><p><a href="${reportUrl}" style="color:#1d4ed8">Read the full daily report</a></p></div></body></html>`
  return { title, date, subject, sections, text, html }
}
