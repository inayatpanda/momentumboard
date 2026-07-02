// Free economic calendar (ForexFactory weekly JSON). High-impact USD/GBP
// events are the tape-movers: FOMC, CPI, NFP, BoE — gap risk for every position.

export interface EconEvent {
  title: string
  country: string
  at: number // epoch seconds
  impact: 'High' | 'Medium' | 'Low'
}

export function parseEconFeed(raw: unknown): EconEvent[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(e => {
      const r = e as { title?: string; country?: string; date?: string; impact?: string }
      const at = r.date ? Date.parse(r.date) / 1000 : NaN
      if (!r.title || !Number.isFinite(at)) return null
      return {
        title: r.title,
        country: r.country ?? '',
        at,
        impact: r.impact === 'High' ? 'High' : r.impact === 'Medium' ? 'Medium' : 'Low',
      } as EconEvent
    })
    .filter((e): e is EconEvent => e !== null)
    .filter(e => (e.country === 'USD' || e.country === 'GBP') && e.impact !== 'Low')
    .sort((a, b) => a.at - b.at)
}

export async function fetchEconCalendar(fetchFn: typeof fetch = fetch): Promise<EconEvent[]> {
  try {
    const res = await fetchFn('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return []
    return parseEconFeed(await res.json())
  } catch {
    return []
  }
}

/** Which warnings are due right now? morning-of (once, after 05:30 UTC on the
 * event's UTC day) and 1h-before (once, 55-70 min out). Keys make firing idempotent. */
export function dueMacroWarnings(events: EconEvent[], nowSec: number, alreadyFired: string[]): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  for (const e of events.filter(e => e.impact === 'High')) {
    const eventDay = new Date(e.at * 1000).toISOString().slice(0, 10)
    const nowDay = new Date(nowSec * 1000).toISOString().slice(0, 10)
    const timeStr = new Date(e.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
    const ukHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowSec * 1000)))
    const morningKey = `macro:${e.title}:${eventDay}:am`
    if (eventDay === nowDay && e.at > nowSec && ukHour >= 7 && !alreadyFired.includes(morningKey)) {
      out.push({ key: morningKey, text: `📅 Today: ${e.title} (${e.country}) at ${timeStr} UK — gap risk, size accordingly` })
    }
    const hourKey = `macro:${e.title}:${eventDay}:1h`
    const minsOut = (e.at - nowSec) / 60
    if (minsOut > 0 && minsOut <= 70 && !alreadyFired.includes(hourKey)) {
      out.push({ key: hourKey, text: `⏰ ${e.title} in ~${Math.round(minsOut)} min (${timeStr} UK) — the tape can whip either way` })
    }
  }
  return out
}
