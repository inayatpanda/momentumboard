// MOMENTUMBOARD DAILY — the guaranteed morning newspaper. The LLM writes the
// journalism (as strict JSON); THIS code owns the layout, so the design never
// depends on a model following CSS instructions. Composed on Netlify itself
// because the Claude cloud routine environment cannot reach the site (proven
// 2026-07-02: four fired sessions, zero PUTs landed, token verified good).

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
  lead: string // 2-3 paragraphs, \n\n separated
  portfolioDesk: string
  tape: string
  ideas: Idea[]
  shortDesk: string
  smallCap?: string
  rotation: string
  crypto: string
  channels: string
  readersNotes?: string
  honestClose: string
  regime: 'green' | 'amber' | 'red'
  fedStance: 'hawkish' | 'neutral' | 'dovish'
  macroNotes: string[]
}

export function composePrompt(data: string, dateLabel: string): string {
  return `You are a seasoned, decisive Wall Street analyst writing MOMENTUMBOARD DAILY for ${dateLabel} — a morning newspaper for one UK retail swing trader (Trading 212 ISA, reversal-first, 1 day-3 week holds, LSE inverse ETPs for shorts, small caps welcome at half size). Persona: confident; both directions are opportunity; numbered reasons; every idea carries an invalidation level; no hedging filler; the honest close carries all caveats. BE SELECTIVE: 1-3 long ideas max, 0-2 shorts, 0-1 small-cap spotlight. Mark an idea strength:"strong" ONLY on multi-factor alignment (setup + regime + independent confirmation) with 3-5 numbered reasons.

TODAY'S DATA (computed by your own systems — ground everything in it, invent nothing):
${data}

Respond with ONLY a JSON object, no markdown fences, exactly this shape:
{"headline":"<punchy newspaper headline for the day's most important thing>","standfirst":"<1-2 sentence italic summary>","lead":"<2-3 paragraphs separated by \\n\\n>","portfolioDesk":"<review of actual positions: hold/tighten/exit/scale-in/rotate with reasons; if empty journal say so in one line>","tape":"<macro brief: regime, futures tone, what matters today>","ideas":[{"ticker":"XYZ","side":"long","playbook":"R","caseText":"<2 lines>","entry":"<level>","invalidation":"<level>","target":"<level>","conviction":"A","strength":"strong","reasons":["..."]}],"shortDesk":"<the overextension fades worth hunting via inverse ETPs, or 'no clean fade today'>","smallCap":"<the discovery with chatter evidence + liquidity check, omit field if none>","rotation":"<where money is going per the sector numbers and how to front-run it>","crypto":"<BTC/ETH regime, levels, alts, crypto equities>","channels":"<what the channels said with YOUR take on each>","readersNotes":"<his observations tested against data: held up / contradicted; omit field if none relevant>","honestClose":"<confidence grade, what proves today wrong, what was unverifiable>","regime":"green|amber|red","fedStance":"hawkish|neutral|dovish","macroNotes":["<1-3 key macro notes>"]}`
}

export function parseComposed(text: string): ComposedReport | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const r = JSON.parse(m[0]) as ComposedReport
    if (!r.headline || !r.standfirst || !Array.isArray(r.ideas)) return null
    if (!['green', 'amber', 'red'].includes(r.regime)) r.regime = 'amber'
    // models sneak markdown emphasis into prose; the paper sets its own type
    const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/(^|\s)[_*]+|[_*]+(?=\s|$)/g, '$1').trim() : s)
    for (const k of Object.keys(r) as (keyof ComposedReport)[]) (r as unknown as Record<string, unknown>)[k] = clean(r[k])
    r.ideas = r.ideas.map(i => ({ ...i, caseText: clean(i.caseText) as string }))
    return r
  } catch {
    return null
  }
}

const esc = (s: string | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const paras = (s: string | undefined) =>
  (s ?? '')
    .split(/\n\n+/)
    .filter(Boolean)
    .map(p => `<p>${esc(p.trim())}</p>`)
    .join('')

const REGIME_COLOR: Record<string, string> = { green: '#0c7a55', amber: '#8a6510', red: '#b03040' }

export function buildNewspaperHtml(r: ComposedReport, dateLabel: string, opts: { firstEdition?: boolean; pdfLink?: string } = {}): string {
  const dept = (title: string, body: string) =>
    body ? `<section class="dept"><h2>${title}</h2>${body}</section>` : ''

  const ideasRows = r.ideas
    .map(
      i => `<tr${i.strength === 'strong' ? ' class="strong"' : ''}>
<td class="tk">${esc(i.ticker)}${i.side === 'short' ? ' <span class="short">SHORT</span>' : ''}</td>
<td>${esc(i.playbook)}</td>
<td>${esc(i.caseText)}${i.strength === 'strong' && i.reasons?.length ? `<div class="reasons"><strong>I STRONGLY SUGGEST — </strong>${i.reasons.map((x, n) => `${n + 1}) ${esc(x)}`).join(' ')}</div>` : ''}</td>
<td class="num">${esc(i.entry)}</td><td class="num">${esc(i.invalidation)}</td><td class="num">${esc(i.target)}</td>
<td class="num">${esc(i.conviction)}</td></tr>`,
    )
    .join('')

  const pull = r.ideas.find(i => i.strength === 'strong')?.caseText ?? r.standfirst

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MomentumBoard Daily — ${esc(dateLabel)}</title>
<meta property="og:title" content="${esc(r.headline)}"/>
<meta property="og:description" content="${esc(r.standfirst)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="https://momentumboard-inayat.netlify.app/report"/>
<meta property="og:image" content="https://momentumboard-inayat.netlify.app/icon-512.png"/>
<meta name="twitter:card" content="summary"/>
<style>
:root{color-scheme:light}
body{margin:0;background:#f7f4ec;color:#191713;font:16px/1.65 Georgia,'Times New Roman',serif}
.sheet{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
.rule{border-top:1px solid #191713}.rule.thin{border-color:#d8d2c4}
.masthead{text-align:center;padding:10px 0 6px}
.masthead h1{margin:6px 0 4px;font-size:clamp(26px,5vw,34px);letter-spacing:.24em;font-weight:700}
.edition{font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;color:#6b6257}
.edition b{color:${REGIME_COLOR[r.regime]};letter-spacing:.12em}
.lead{padding:26px 0 8px}
.lead h2{font-size:clamp(24px,4.4vw,30px);line-height:1.2;margin:0 0 10px}
.standfirst{font-style:italic;font-size:18px;color:#3d382f;margin:0 0 6px}
.byline{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6b6257;margin:10px 0 14px}
.cols{column-gap:36px}
@media(min-width:760px){.cols{column-count:2}}
.dept{break-inside:avoid;margin:0 0 22px}
.dept h2{font-size:13px;letter-spacing:.18em;text-transform:uppercase;border-top:2px solid #191713;padding-top:8px;margin:0 0 8px}
.dept p{margin:0 0 10px}
.pull{column-span:all;border-top:1px solid #191713;border-bottom:1px solid #191713;margin:24px 0;padding:18px 8px;text-align:center;font-style:italic;font-size:clamp(19px,3vw,24px);line-height:1.45}
table{width:100%;border-collapse:collapse;font-size:14px;margin:4px 0 8px}
th{font-size:11px;letter-spacing:.14em;text-transform:uppercase;text-align:left;border-bottom:1px solid #191713;padding:6px 8px}
td{border-bottom:1px solid #d8d2c4;padding:8px;vertical-align:top}
.tk{font-weight:700;white-space:nowrap}.short{color:#b03040;font-size:10.5px;letter-spacing:.08em}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
tr.strong td{background:rgba(12,122,85,.06)}
.reasons{margin-top:6px;font-size:13px;color:#3d382f}
.ideas-wrap{column-span:all}
.notice{font-size:13px;font-style:italic;color:#6b6257;text-align:center;margin:8px 0 0}
footer{margin-top:34px;border-top:2px solid #191713;padding-top:12px;font-size:12.5px;color:#6b6257;text-align:center}
@media print{body{background:#fff}.sheet{max-width:none;padding:0}}
</style></head>
<body><div class="sheet">
<div class="rule"></div><div class="rule thin" style="margin-top:2px"></div>
<div class="masthead">
<h1>MOMENTUMBOARD DAILY</h1>
<div class="edition">London · ${esc(dateLabel)} · Regime: <b>${r.regime.toUpperCase()}</b> · The Morning Sweep</div>
</div>
<div class="rule thin"></div><div class="rule" style="margin-top:2px"></div>
${opts.pdfLink ? `<p class="notice">Print edition (PDF): <a href="${esc(opts.pdfLink)}">${esc(opts.pdfLink)}</a></p>` : ''}
${opts.firstEdition ? `<p class="notice">First edition — the full edition follows by 07:15 UK.</p>` : ''}
<div class="lead">
<h2>${esc(r.headline)}</h2>
<p class="standfirst">${esc(r.standfirst)}</p>
<div class="byline">By The Desk · MomentumBoard Research</div>
${paras(r.lead)}
</div>
<div class="cols">
${dept('Portfolio Desk', paras(r.portfolioDesk))}
${dept('The Tape', paras(r.tape))}
${
  r.ideas.length
    ? `<section class="dept ideas-wrap"><h2>Today's Ideas</h2><table><thead><tr><th>Ticker</th><th>Play</th><th>The case</th><th>Entry</th><th>Invalidation</th><th>Target</th><th>Grade</th></tr></thead><tbody>${ideasRows}</tbody></table></section>`
    : ''
}
<div class="pull">&ldquo;${esc(pull)}&rdquo;</div>
${dept('The Short Desk', paras(r.shortDesk))}
${r.smallCap ? dept('Small-Cap Wire', paras(r.smallCap)) : ''}
${dept('Rotation Radar', paras(r.rotation))}
${dept('Crypto Wire', paras(r.crypto))}
${dept('The Channels', paras(r.channels))}
${r.readersNotes ? dept("Reader's Notes", paras(r.readersNotes)) : ''}
${dept('The Honest Close', paras(r.honestClose))}
</div>
<footer>Research, not advice. Markets can invalidate any thesis. Verify ISA eligibility per product on Trading 212.<br>momentumboard-inayat.netlify.app/report</footer>
</div></body></html>`
}
