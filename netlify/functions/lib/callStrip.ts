// The paper's call blocks print three fixed numbers — entry, invalidation,
// target — and `entry` is a pre-open quote, i.e. the PREVIOUS session's close.
// Read the paper at lunchtime and you cannot tell whether the setup is still
// there, has already run, or died hours ago.
//
// The composer leaves an empty <span data-call-status="TICKER"></span> in each
// block and report.mts fills it AT READ TIME. Filling on read rather than at
// publish keeps the stored edition a clean record, and keeps the PDF and the
// emailed copy free of both stale prices and any JavaScript — an unfilled
// marker renders as nothing at all.

import { callStatus, type CallLevels } from '../../../shared/engine/callStatus'

export interface EditionCall extends CallLevels {
  sym: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const BADGE: Record<string, { label: string; colour: string }> = {
  'through-stop': { label: 'through stop', colour: '#a3232f' },
  'at-target': { label: 'at target', colour: '#1c7a55' },
  extended: { label: 'extended', colour: '#8a6510' },
}

/** Replace every status marker with a rendered strip. Any call we cannot price
 * — no quote, no levels, a nonsense number — has its marker removed instead,
 * so the page never shows a half-answer. */
export function fillCallStatus(
  html: string,
  calls: EditionCall[],
  priceOf: (sym: string) => number | null,
  opts: { live: boolean },
): string {
  const bySym = new Map(calls.map(c => [c.sym, c]))
  return html.replace(/<span data-call-status="([^"]*)"><\/span>/g, (_m, raw: string) => {
    // the attribute was escaped on the way in; undo it to match the stored sym
    const sym = raw.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    const call = bySym.get(sym)
    if (!call) return ''
    const price = priceOf(sym)
    if (price == null) return ''
    const s = callStatus(call, price)
    if (!s) return ''

    const move = `${s.pctFromEntry >= 0 ? '+' : ''}${s.pctFromEntry.toFixed(1)}%`
    const moveColour = s.pctFromEntry >= 0 ? '#1c7a55' : '#a3232f'
    // "now" is a claim about right now — an archived edition must not make it.
    const lead = opts.live ? `now ${price.toFixed(2)}` : `since this call: ${price.toFixed(2)}`
    const stopPart =
      s.pctToStop >= 0 ? `invalidation ${s.pctToStop.toFixed(1)}% away` : `invalidation breached by ${Math.abs(s.pctToStop).toFixed(1)}%`
    const badge = BADGE[s.state]
    return (
      `<div style="margin:-6px 0 11px;font-size:12px;color:#6b6257;letter-spacing:.01em">` +
      `${esc(lead)} &middot; <span style="color:${moveColour};font-weight:700">${esc(move)} from entry</span> &middot; ${esc(stopPart)}` +
      (badge
        ? `<span style="border:1px solid ${badge.colour};border-radius:3px;padding:1px 5px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:${badge.colour};margin-left:7px">${badge.label}</span>`
        : '') +
      `</div>`
    )
  })
}

/** The numeric calls in an edition. The composer's entry/invalidation/target are
 * free text — they are deliberately QUALITATIVE when no price was available
 * ("reclaim of the 20-day on volume") — so anything that does not parse as three
 * real numbers simply gets no strip. */
export function numericCalls(
  ideas: { ticker: string; side: 'long' | 'short'; entry: string; invalidation: string; target: string }[],
): EditionCall[] {
  const out: EditionCall[] = []
  for (const i of ideas) {
    const entry = Number(String(i.entry).replace(/[^0-9.-]/g, ''))
    const stop = Number(String(i.invalidation).replace(/[^0-9.-]/g, ''))
    const target = Number(String(i.target).replace(/[^0-9.-]/g, ''))
    if (![entry, stop, target].every(n => Number.isFinite(n) && n > 0)) continue
    out.push({ sym: i.ticker, side: i.side, entry, stop, target })
  }
  return out
}
