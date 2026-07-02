// THE STREET SIGNAL — the guaranteed morning newspaper. The LLM writes the
// journalism (strict JSON); THIS code owns the layout, tables and charts, so
// depth and design never depend on a model following instructions. Composed on
// Netlify itself because the Claude cloud routine environment cannot reach the
// site (proven 2026-07-02).

export interface Idea {
  ticker: string
  side: 'long' | 'short'
  playbook: 'R' | 'B' | 'A' | 'S'
  caseText: string
  entry: string
  invalidation: string
  target: string
  conviction: 'A' | 'B' | 'C'
  strength?: 'strong'
  reasons?: string[]
}

export interface ComposedReport {
  headline: string
  standfirst: string
  lead: string // 3-4 paragraphs, \n\n separated
  portfolioDesk: string
  tape: string
  ideas: Idea[]
  shortDesk: string
  smallCap?: string
  rotation: string
  crypto: string
  channels: string
  readersNotes?: string
  editorial: string // THE LONG VIEW: market history & investor wisdom tied to today
  honestClose: string
  regime: 'green' | 'amber' | 'red'
  fedStance: 'hawkish' | 'neutral' | 'dovish'
  macroNotes: string[]
}

// ---------- deterministic extras the builder renders from real data ----------

export interface RotationTable {
  sector: string
  etf: string
  rows: { sym: string; price: number | null; wkPct: number | null; closes?: number[] }[]
}

export interface SocialRow {
  sym: string
  redditRank: number | null
  redditMentions: number | null
  surgeMultiple: number | null
  sources: number
  capUsdM?: number | null
}

export interface CalendarRow {
  title: string
  country: string
  at: number
  impact: string
  forecast?: string
  previous?: string
}

export interface PaperExtras {
  firstEdition?: boolean
  pdfLink?: string
  rotationTables?: RotationTable[]
  socialBoard?: SocialRow[]
  calendar?: CalendarRow[]
  spyCloses?: number[] // ~3 months for the masthead chart
  sectorBars?: { name: string; rs21: number | null }[]
}

// A rotating masthead quote — curated, deterministic by date.
export const STREET_WISDOM: { q: string; by: string }[] = [
  { q: 'The big money is not in the buying and the selling, but in the waiting.', by: 'Charlie Munger' },
  { q: 'Markets can remain irrational longer than you can remain solvent.', by: 'John Maynard Keynes' },
  { q: 'Be fearful when others are greedy and greedy when others are fearful.', by: 'Warren Buffett' },
  { q: 'The trend is your friend until the end when it bends.', by: 'Ed Seykota' },
  { q: 'It never was my thinking that made the big money for me. It always was my sitting.', by: 'Jesse Livermore' },
  { q: 'Know what you own, and know why you own it.', by: 'Peter Lynch' },
  { q: 'The four most dangerous words in investing are: this time it is different.', by: 'Sir John Templeton' },
  { q: 'Risk comes from not knowing what you are doing.', by: 'Warren Buffett' },
  { q: 'In the short run the market is a voting machine, but in the long run it is a weighing machine.', by: 'Benjamin Graham' },
  { q: 'It is not whether you are right or wrong, but how much money you make when right and how much you lose when wrong.', by: 'George Soros' },
  { q: 'The stock market is a device for transferring money from the impatient to the patient.', by: 'Warren Buffett' },
  { q: 'Never confuse genius with a bull market.', by: 'Wall Street proverb' },
  { q: 'Bull markets are born on pessimism, grow on scepticism, mature on optimism, and die on euphoria.', by: 'Sir John Templeton' },
  { q: 'The first rule of trading: never average a loss without a plan. The exception proves nothing.', by: 'Jesse Livermore' },
  { q: 'Cut your losses short and let your winners run.', by: 'David Ricardo' },
  { q: 'What the wise man does in the beginning, the fool does in the end.', by: 'Howard Marks' },
  { q: 'Buy when there is blood in the streets, even if the blood is your own.', by: 'Baron Rothschild' },
  { q: 'The market is never wrong; opinions often are.', by: 'Jesse Livermore' },
  { q: 'Time in the market beats timing the market — except when the tape says otherwise.', by: 'Street adage' },
  { q: 'Every once in a while, the market does something so stupid it takes your breath away.', by: 'Jim Cramer' },
]

export function pickWisdom(dateISO: string): { q: string; by: string } {
  const dayIndex = Math.floor(Date.parse(dateISO) / 86_400_000)
  return STREET_WISDOM[dayIndex % STREET_WISDOM.length]
}

// ---------- compose prompt + parsing ----------

export function composePrompt(data: string, dateLabel: string): string {
  return `You are a seasoned, decisive Wall Street analyst writing THE STREET SIGNAL for ${dateLabel} — a morning newspaper for one UK retail swing trader (Trading 212 ISA, reversal-first, 1 day-3 week holds, LSE inverse ETPs for shorts, small caps welcome at half size). Persona: confident; both directions are opportunity; numbered reasons; every idea carries an invalidation; no hedging filler; the honest close carries all caveats. BE SELECTIVE: 1-3 long ideas max, 0-2 shorts, 0-1 small-cap spotlight. Mark strength:"strong" ONLY on multi-factor alignment with 3-5 numbered reasons.

NUMERIC DISCIPLINE (hard rules):
- Use ONLY numbers present in the data below. NEVER invent a price, level or statistic.
- No current price provided for a ticker → entry/invalidation/target must be QUALITATIVE ("reclaim of the 20-day on volume").
- Crypto/index levels only if present in the data.
- If userNotes is empty, OMIT readersNotes. If portfolio is null/empty, portfolioDesk is one honest line.

CONTINUITY (you write this paper EVERY day — the reader read yesterday's):
- previousEditions in the data show what you already told him. NEVER re-explain or re-introduce a theme covered in the last editions as if it were new.
- Track open narratives instead: "the healthcare rotation we flagged yesterday is now on day 3 and looks CONFIRMED — 1-week strength (rs5) still leads 1-month (rs21)" or "yesterday's rotation call is fading; one-day event, stand down."
- Grade every recurring theme explicitly: one-day blip vs confirmed trend, judged from rs5 vs rs21 and pick persistence.
- Repeated picks: say plainly it is a repeat, what has changed since, and whether conviction rose or fell.

NAMES: give each company's FULL name once at first mention (e.g. "AbbVie (ABBV)", "Nebius Group (NBIS)") in caseText, smallCap and channels — the reader should never meet a bare unfamiliar ticker.

DEPTH REQUIREMENTS:
- lead: 3-4 substantial paragraphs telling today's story.
- tape MUST preview the next 48h of high-impact events from econCalendar using their forecast vs previous numbers ("Jobs report Friday: consensus X vs Y prior — a miss revives cut bets") and say how to position around each.
- Weave the socialPulse names (including the small caps with their surge multiples and market caps) into smallCap/channels — several names, each with YOUR take, never bare chatter.
- editorial ("The Long View"): 2-3 paragraphs of market history and investor wisdom TIED to today's conditions — a specific well-known historical episode or a great investor's principle that rhymes with the current tape (rotations, seasonality, sentiment extremes). Well-established market history only; no invented statistics.

TODAY'S DATA (computed by your own systems — ground everything in it):
${data}

Respond with ONLY a JSON object, no markdown fences, exactly this shape:
{"headline":"...","standfirst":"...","lead":"<3-4 paragraphs \\n\\n separated>","portfolioDesk":"...","tape":"<incl. 48h event previews with forecast vs previous>","ideas":[{"ticker":"XYZ","side":"long","playbook":"R","caseText":"...","entry":"...","invalidation":"...","target":"...","conviction":"A","strength":"strong","reasons":["..."]}],"shortDesk":"...","smallCap":"<omit if none>","rotation":"...","crypto":"...","channels":"...","readersNotes":"<omit if no notes>","editorial":"<The Long View: 2-3 paragraphs>","honestClose":"...","regime":"green|amber|red","fedStance":"hawkish|neutral|dovish","macroNotes":["..."]}`
}

export function extractJson<T>(raw: string): T | null {
  const text = raw.replace(/```(?:json)?/g, '') // models love fences
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as T
  } catch {
    return null
  }
}

export function sanitizeComposed(r: ComposedReport): ComposedReport | null {
  if (!r.headline || !r.standfirst || !Array.isArray(r.ideas)) return null
  if (!['green', 'amber', 'red'].includes(r.regime)) r.regime = 'amber'
  // models sneak markdown emphasis into prose; the paper sets its own type
  const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/(^|\s)[_*]+|[_*]+(?=\s|$)/g, '$1').trim() : s)
  for (const k of Object.keys(r) as (keyof ComposedReport)[]) (r as unknown as Record<string, unknown>)[k] = clean(r[k])
  r.ideas = r.ideas.map(i => ({ ...i, caseText: clean(i.caseText) as string }))
  return r
}

export function parseComposed(raw: string): ComposedReport | null {
  const r = extractJson<ComposedReport>(raw)
  return r ? sanitizeComposed(r) : null
}

// ---------- sectioned compose: six small writes instead of one big one ----------
// Small outputs fit Groq's free-tier limits, truncate rarely, and retry cheaply.

export interface SectionSpec {
  key: string
  fields: string[]
  brief: string // what this section must deliver
  shape: string // the exact JSON shape line
}

export const SECTIONS: SectionSpec[] = [
  {
    key: 'lead',
    fields: ['headline', 'standfirst', 'lead', 'regime', 'fedStance', 'macroNotes'],
    brief: 'The front page: a punchy newspaper headline for the day\'s most important thing, a 1-2 sentence italic standfirst, and a lead of 3-4 substantial paragraphs telling today\'s story. Also your regime/fedStance verdicts and 1-3 macroNotes.',
    shape: '{"headline":"...","standfirst":"...","lead":"<3-4 paragraphs \\n\\n separated>","regime":"green|amber|red","fedStance":"hawkish|neutral|dovish","macroNotes":["..."]}',
  },
  {
    key: 'desk',
    fields: ['portfolioDesk', 'tape'],
    brief: 'portfolioDesk: review of the actual positions (hold/tighten/exit/scale-in/rotate with reasons; one honest line if the journal is empty). tape: the macro brief, and it MUST preview the next 48h of high-impact events from econCalendarThisWeek using their forecast vs previous numbers and say how to position around each.',
    shape: '{"portfolioDesk":"...","tape":"..."}',
  },
  {
    key: 'ideas',
    fields: ['ideas', 'shortDesk'],
    brief: '1-3 long ideas MAX and the short desk (0-2 fades via LSE inverse ETPs, or say no clean fade). Every idea: full company name once in caseText, playbook tag, entry/invalidation/target (numeric ONLY if the price is in the data, else qualitative), conviction A/B/C. strength:"strong" ONLY on multi-factor alignment with 3-5 numbered reasons.',
    shape: '{"ideas":[{"ticker":"XYZ","side":"long|short","playbook":"R|B|A|S","caseText":"...","entry":"...","invalidation":"...","target":"...","conviction":"A|B|C","strength":"strong (omit unless earned)","reasons":["..."]}],"shortDesk":"..."}',
  },
  {
    key: 'discovery',
    fields: ['smallCap', 'channels', 'readersNotes'],
    brief: 'smallCap: the 0-1 discovery from socialPulse with full company name, surge evidence, market cap, liquidity check (omit field if none deserves it). channels: what the channels said, several names each with YOUR take. readersNotes: his observations tested against data — held up or contradicted (omit if userNotes is empty).',
    shape: '{"smallCap":"<omit if none>","channels":"...","readersNotes":"<omit if no notes>"}',
  },
  {
    key: 'rotation',
    fields: ['rotation', 'crypto'],
    brief: 'rotation: where money is going per the sector numbers (rs5 vs rs21 tells you one-day blip vs confirmed) and how to front-run it. crypto: BTC/ETH regime with only the levels present in the data, alts, crypto equities.',
    shape: '{"rotation":"...","crypto":"..."}',
  },
  {
    key: 'voice',
    fields: ['editorial', 'honestClose'],
    brief: 'editorial (The Long View): 2-3 paragraphs of well-established market history or a great investor\'s principle that rhymes with TODAY\'s tape — tied explicitly to current conditions, no invented statistics. honestClose: confidence grade, what proves today wrong, what was unverifiable.',
    shape: '{"editorial":"...","honestClose":"..."}',
  },
]

const PERSONA = (dateLabel: string) => `You are a seasoned, decisive Wall Street analyst writing THE STREET SIGNAL for ${dateLabel} — a morning newspaper for one UK retail swing trader (Trading 212 ISA, reversal-first, 1 day-3 week holds, LSE inverse ETPs for shorts, small caps welcome at half size). Confident; both directions are opportunity; numbered reasons; no hedging filler.
NUMERIC DISCIPLINE: use ONLY numbers present in the data; never invent a price, level or statistic; no price for a ticker → qualitative levels only.
CONTINUITY: previousEditions in the data show what the reader was already told. Never re-introduce a covered theme as new — reference and build ("the healthcare rotation we flagged is now day 3 and CONFIRMED: rs5 still leads rs21" / "yesterday's call is fading — one-day event"). Repeated picks: say it is a repeat and what changed.
NAMES: full company name once at first mention of any ticker.`

export function sectionPrompt(spec: SectionSpec, data: string, dateLabel: string): string {
  return `${PERSONA(dateLabel)}

YOUR SECTION — write ONLY these fields: ${spec.fields.join(', ')}.
${spec.brief}

TODAY'S DATA (ground everything in it):
${data}

Respond with ONLY this JSON object, no markdown fences:
${spec.shape}`
}

/** Merge section outputs into a full report; null if the essentials are missing. */
export function mergeSections(parts: (Record<string, unknown> | null)[]): ComposedReport | null {
  const merged = Object.assign({}, ...parts.filter(Boolean)) as ComposedReport
  if (!Array.isArray(merged.ideas)) merged.ideas = []
  return sanitizeComposed(merged)
}

// ---------- svg charts (pure, deterministic) ----------

export function sparklineSvg(closes: number[], w = 120, h = 28, stroke = '#191713'): string {
  if (closes.length < 2) return ''
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const pts = closes.map((c, i) => `${((i / (closes.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((c - min) / span) * (h - 4)).toFixed(1)}`)
  const up = closes[closes.length - 1] >= closes[0]
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${stroke === 'auto' ? (up ? '#0c7a55' : '#b03040') : stroke}" stroke-width="1.6" stroke-linejoin="round"/></svg>`
}

export function sectorBarsSvg(bars: { name: string; rs21: number | null }[], w = 480): string {
  const rows = bars.filter(b => b.rs21 != null).slice(0, 11)
  if (!rows.length) return ''
  const maxAbs = Math.max(...rows.map(b => Math.abs(b.rs21!)), 1)
  const rowH = 20
  const mid = w / 2 + 40
  const scale = (w / 2 - 90) / maxAbs
  const items = rows
    .map((b, i) => {
      const y = i * rowH
      const len = Math.abs(b.rs21!) * scale
      const xPos = b.rs21! >= 0 ? mid : mid - len
      const color = b.rs21! >= 0 ? '#0c7a55' : '#b03040'
      return `<text x="${mid - (b.rs21! >= 0 ? 6 : len + 6)}" y="${y + 14}" font-size="11" text-anchor="end" fill="#191713" font-family="Georgia,serif">${b.name}</text>
<rect x="${xPos}" y="${y + 4}" width="${Math.max(len, 1)}" height="12" fill="${color}" opacity="0.85"/>
<text x="${b.rs21! >= 0 ? xPos + len + 5 : xPos - 5}" y="${y + 14}" font-size="10.5" text-anchor="${b.rs21! >= 0 ? 'start' : 'end'}" fill="#6b6257" font-family="Georgia,serif">${b.rs21! >= 0 ? '+' : ''}${b.rs21}</text>`
    })
    .join('\n')
  return `<svg width="100%" viewBox="0 0 ${w} ${rows.length * rowH + 4}" aria-label="Sector relative strength vs SPY, one month"><line x1="${mid}" y1="0" x2="${mid}" y2="${rows.length * rowH}" stroke="#d8d2c4"/>${items}</svg>`
}

// ---------- the paper ----------

// models sometimes hand back arrays where strings were asked for — coerce, never crash
const asText = (s: unknown): string =>
  Array.isArray(s)
    ? s.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n\n')
    : typeof s === 'string'
      ? s
      : s == null
        ? ''
        : String(s)

const esc = (s: unknown) =>
  asText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const paras = (s: unknown) =>
  asText(s)
    .split(/\n\n+/)
    .filter(Boolean)
    .map(p => `<p>${esc(p.trim())}</p>`)
    .join('')

const REGIME_COLOR: Record<string, string> = { green: '#0c7a55', amber: '#8a6510', red: '#b03040' }
const num = (v: number | null | undefined, dp = 1) => (v == null ? '·' : v.toFixed(dp))

export function buildNewspaperHtml(r: ComposedReport, dateLabel: string, x: PaperExtras = {}): string {
  const dept = (title: string, body: string) => (body ? `<section class="dept"><h2>${title}</h2>${body}</section>` : '')
  const wide = (title: string, body: string) => (body ? `<section class="dept wide"><h2>${title}</h2>${body}</section>` : '')

  const ideasRows = r.ideas
    .map(
      i => `<tr${i.strength === 'strong' ? ' class="strong"' : ''}>
<td class="tk">${esc(i.ticker)}${i.side === 'short' ? ' <span class="short">SHORT</span>' : ''}</td>
<td>${esc(i.playbook)}</td>
<td>${esc(i.caseText)}${i.strength === 'strong' && i.reasons?.length ? `<div class="reasons"><strong>I STRONGLY SUGGEST — </strong>${i.reasons.map((t, n) => `${n + 1}) ${esc(t)}`).join(' ')}</div>` : ''}</td>
<td class="num">${esc(i.entry)}</td><td class="num">${esc(i.invalidation)}</td><td class="num">${esc(i.target)}</td><td class="num">${esc(i.conviction)}</td></tr>`,
    )
    .join('')

  const calendarRows = (x.calendar ?? [])
    .slice(0, 6)
    .map(e => {
      const when = new Date(e.at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
      return `<tr><td>${esc(e.title)} <span class="chip ${e.impact === 'High' ? 'hi' : ''}">${esc(e.impact)}</span></td><td class="num">${esc(e.country)}</td><td class="num">${when} UK</td><td class="num">${esc(e.forecast ?? '·')}</td><td class="num">${esc(e.previous ?? '·')}</td></tr>`
    })
    .join('')

  const rotationBlocks = (x.rotationTables ?? [])
    .map(
      t => `<h3 class="subhead">${esc(t.sector)} <span class="etf">(${esc(t.etf)})</span></h3>
<table><thead><tr><th>Stock</th><th>Price</th><th>1 week</th><th>Trend (3mo)</th></tr></thead><tbody>
${t.rows
  .map(
    row => `<tr><td class="tk">${esc(row.sym)}</td><td class="num">${row.price == null ? '·' : row.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td class="num ${row.wkPct != null && row.wkPct >= 0 ? 'up' : 'dn'}">${row.wkPct == null ? '·' : `${row.wkPct >= 0 ? '+' : ''}${num(row.wkPct)}%`}</td><td>${row.closes?.length ? sparklineSvg(row.closes, 110, 24, 'auto') : ''}</td></tr>`,
  )
  .join('')}
</tbody></table>`,
    )
    .join('')

  const socialRows = (x.socialBoard ?? [])
    .slice(0, 10)
    .map(
      s => `<tr><td class="tk">${esc(s.sym)}</td><td class="num">${s.capUsdM == null ? '·' : s.capUsdM >= 1000 ? `$${(s.capUsdM / 1000).toFixed(1)}B` : `$${Math.round(s.capUsdM)}M`}</td><td class="num">${s.redditRank == null ? '·' : `#${s.redditRank}`}</td><td class="num">${s.redditMentions ?? '·'}</td><td class="num ${s.surgeMultiple != null && s.surgeMultiple >= 2 ? 'up' : ''}">${s.surgeMultiple == null ? '·' : `${s.surgeMultiple}×`}</td><td class="num">${s.sources}</td></tr>`,
    )
    .join('')

  const wisdom = pickWisdom(new Date().toISOString().slice(0, 10))
  const pull = r.ideas.find(i => i.strength === 'strong')?.caseText ?? r.standfirst

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Street Signal — ${esc(dateLabel)}</title>
<meta property="og:title" content="${esc(r.headline)}"/>
<meta property="og:description" content="${esc(r.standfirst)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="https://streetsignal.netlify.app/report"/>
<meta property="og:image" content="https://streetsignal.netlify.app/icon-512.png"/>
<meta name="twitter:card" content="summary"/>
<style>
:root{color-scheme:light}
body{margin:0;background:#f7f4ec;color:#191713;font:16px/1.65 Georgia,'Times New Roman',serif}
.sheet{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
.rule{border-top:1px solid #191713}.rule.thin{border-color:#d8d2c4}
.masthead{text-align:center;padding:10px 0 6px}
.masthead h1{margin:6px 0 4px;font-size:clamp(26px,5vw,36px);letter-spacing:.22em;font-weight:700}
.edition{font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;color:#6b6257}
.edition b{color:${REGIME_COLOR[r.regime]};letter-spacing:.12em}
.wisdom{text-align:center;font-style:italic;font-size:14px;color:#3d382f;margin:8px auto 0;max-width:620px}
.wisdom span{font-style:normal;font-size:12px;letter-spacing:.08em;color:#6b6257}
.lead{padding:26px 0 8px}
.lead h2{font-size:clamp(24px,4.4vw,31px);line-height:1.2;margin:0 0 10px}
.standfirst{font-style:italic;font-size:18px;color:#3d382f;margin:0 0 6px}
.byline{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6b6257;margin:10px 0 14px}
.cols{column-gap:36px}
@media(min-width:760px){.cols{column-count:2}}
.dept{break-inside:avoid;margin:0 0 22px}
.dept.wide{column-span:all}
.dept h2{font-size:13px;letter-spacing:.18em;text-transform:uppercase;border-top:2px solid #191713;padding-top:8px;margin:0 0 8px}
.dept p{margin:0 0 10px}
.subhead{font-size:15px;margin:12px 0 2px}.etf{color:#6b6257;font-weight:400;font-size:12px}
.pull{column-span:all;border-top:1px solid #191713;border-bottom:1px solid #191713;margin:24px 0;padding:18px 8px;text-align:center;font-style:italic;font-size:clamp(19px,3vw,24px);line-height:1.45}
table{width:100%;border-collapse:collapse;font-size:14px;margin:4px 0 8px}
th{font-size:11px;letter-spacing:.14em;text-transform:uppercase;text-align:left;border-bottom:1px solid #191713;padding:6px 8px}
td{border-bottom:1px solid #d8d2c4;padding:7px 8px;vertical-align:middle}
table.ideas{table-layout:fixed}
table.ideas th:nth-child(1){width:9%}table.ideas th:nth-child(2){width:6%}table.ideas th:nth-child(3){width:43%}table.ideas th:nth-child(4),table.ideas th:nth-child(5),table.ideas th:nth-child(6){width:12%}table.ideas th:nth-child(7){width:6%}
table.ideas td{white-space:normal}table.ideas td.num{white-space:normal;overflow-wrap:break-word}
.tk{font-weight:700;white-space:nowrap}.short{color:#b03040;font-size:10.5px;letter-spacing:.08em}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.up{color:#0c7a55}.dn{color:#b03040}
tr.strong td{background:rgba(12,122,85,.06)}
.reasons{margin-top:6px;font-size:13px;color:#3d382f}
.chip{font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid #d8d2c4;border-radius:3px;padding:1px 5px;color:#6b6257}
.chip.hi{color:#b03040;border-color:#b03040}
.glance{display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start}
.glance figure{margin:0}.glance figcaption{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b6257;margin-top:4px}
.editorial{background:rgba(25,23,19,.035);padding:16px 18px;border-top:2px solid #191713}
.notice{font-size:13px;font-style:italic;color:#6b6257;text-align:center;margin:8px 0 0}
footer{margin-top:34px;border-top:2px solid #191713;padding-top:12px;font-size:12.5px;color:#6b6257;text-align:center;letter-spacing:.08em}
@media(max-width:600px){
.masthead h1{letter-spacing:.1em}
.dept table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
.glance{gap:14px}
}
body{overflow-x:hidden}
@media print{body{background:#fff}.sheet{max-width:none;padding:0}}
</style></head>
<body><div class="sheet">
<div class="rule"></div><div class="rule thin" style="margin-top:2px"></div>
<div class="masthead">
<h1>THE STREET SIGNAL</h1>
<div class="edition">London · ${esc(dateLabel)} · Regime: <b>${r.regime.toUpperCase()}</b> · The Morning Sweep</div>
<div class="wisdom">&ldquo;${esc(wisdom.q)}&rdquo; <span>— ${esc(wisdom.by)}</span></div>
</div>
<div class="rule thin"></div><div class="rule" style="margin-top:2px"></div>
${x.pdfLink ? `<p class="notice">Print edition (PDF): <a href="${esc(x.pdfLink)}">${esc(x.pdfLink)}</a></p>` : ''}
${x.firstEdition ? `<p class="notice">First edition — the full edition follows by 07:15 UK.</p>` : ''}
<div class="lead">
<h2>${esc(r.headline)}</h2>
<p class="standfirst">${esc(r.standfirst)}</p>
<div class="byline">By The Desk · Street Signal Research</div>
${paras(r.lead)}
</div>
<div class="cols">
${wide(
    'Markets at a Glance',
    `<div class="glance">${x.spyCloses?.length ? `<figure>${sparklineSvg(x.spyCloses, 300, 64, 'auto')}<figcaption>S&amp;P 500 · three months</figcaption></figure>` : ''}${x.sectorBars?.length ? `<figure style="flex:1;min-width:280px">${sectorBarsSvg(x.sectorBars)}<figcaption>Sector strength vs S&amp;P · one month (pp)</figcaption></figure>` : ''}</div>`,
  )}
${dept('Portfolio Desk', paras(r.portfolioDesk))}
${dept('The Tape', paras(r.tape))}
${
    calendarRows
      ? wide('On the Calendar — What to Expect', `<table><thead><tr><th>Event</th><th>Ccy</th><th>When</th><th>Forecast</th><th>Previous</th></tr></thead><tbody>${calendarRows}</tbody></table>`)
      : ''
  }
${
    r.ideas.length
      ? wide("Today's Ideas", `<table class="ideas"><thead><tr><th>Ticker</th><th>Play</th><th>The case</th><th>Entry</th><th>Invalidation</th><th>Target</th><th>Grade</th></tr></thead><tbody>${ideasRows}</tbody></table>`)
      : ''
  }
<div class="pull">&ldquo;${esc(pull)}&rdquo;</div>
${dept('The Short Desk', paras(r.shortDesk))}
${r.smallCap ? dept('Small-Cap Wire', paras(r.smallCap)) : ''}
${dept('Rotation Radar', paras(r.rotation))}
${rotationBlocks ? wide('Inside the Rotation', rotationBlocks) : ''}
${
    socialRows
      ? wide('The Social Board', `<table><thead><tr><th>Ticker</th><th>Mkt cap</th><th>r/ rank</th><th>Mentions</th><th>24h surge</th><th>Platforms</th></tr></thead><tbody>${socialRows}</tbody></table>`)
      : ''
  }
${dept('Crypto Wire', paras(r.crypto))}
${dept('The Channels', paras(r.channels))}
${r.readersNotes ? dept("Reader's Notes", paras(r.readersNotes)) : ''}
${r.editorial ? wide('The Long View', `<div class="editorial">${paras(r.editorial)}</div>`) : ''}
${dept('The Honest Close', paras(r.honestClose))}
</div>
<footer>THE STREET SIGNAL · streetsignal.netlify.app/report</footer>
</div></body></html>`
}
