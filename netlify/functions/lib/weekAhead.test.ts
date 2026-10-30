import { describe, expect, it } from 'vitest'
import { buildNewspaperHtml, planSections, SECTIONS, WEEK_AHEAD_SECTION, type CalendarRow, type ComposedReport } from './newspaper'
import type { NasdaqEarningsRow } from './nasdaqEarnings'
import { correctTapeWeekdays } from './paperFacts'
import {
  coversWeek,
  indexLevelLine,
  isWeekAheadDay,
  weekAheadDates,
  weekAheadDays,
  weekAheadEarnings,
  weekAheadEventLines,
  weekAheadEvents,
  weekAheadFacts,
} from './weekAhead'

const sec = (iso: string) => Date.parse(iso) / 1000

// Sunday 1 November 2026, 06:40 London (GMT — the clocks went back on 25 Oct)
const SUNDAY = sec('2026-11-01T06:40:00Z')
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']

const earning = (sym: string, date: string, capUsdM: number | null, time: NasdaqEarningsRow['time'] = 'post'): NasdaqEarningsRow => ({
  sym, date, time, epsActual: null, epsForecast: null, surprisePct: null, noOfEsts: null, marketCapUsdM: capUsdM,
})
const event = (title: string, iso: string, impact: CalendarRow['impact'] = 'High', country = 'USD'): CalendarRow => ({
  title, country, at: sec(iso), impact, forecast: '49.5', previous: '48.7',
})

describe('which day, and which week', () => {
  it('Sunday in London is week-ahead day — and only Sunday', () => {
    expect(isWeekAheadDay(SUNDAY)).toBe(true)
    expect(isWeekAheadDay(SUNDAY - 86_400)).toBe(false) // Saturday
    expect(isWeekAheadDay(SUNDAY + 86_400)).toBe(false) // Monday
  })

  it('uses LONDON, not UTC: 00:30 BST on a Sunday is still Saturday in UTC', () => {
    expect(isWeekAheadDay(sec('2026-10-17T23:30:00Z'))).toBe(true) // Sun 18 Oct 00:30 BST
  })

  it('covers the coming Monday to Friday', () => {
    expect(weekAheadDates(SUNDAY)).toEqual(WEEK)
  })
})

describe('the earnings worth a line', () => {
  const rows = [
    earning('AAPL', '2026-11-05', 3_900_000),
    earning('TINY', '2026-11-03', 400),
    earning('WATCHED', '2026-11-04', 900),
    earning('NVDA', '2026-11-19', 4_500_000), // the week after — out
    earning('MSFT', '2026-10-30', 3_700_000), // already printed — out
  ]

  it('keeps the market-movers and the watchlist names, inside the week only', () => {
    expect(weekAheadEarnings(rows, WEEK, ['watched']).map(r => r.sym)).toEqual(['AAPL', 'WATCHED'])
  })

  it('caps the list, biggest first', () => {
    const many = Array.from({ length: 30 }, (_, i) => earning(`S${i}`, '2026-11-03', 200_000 + i))
    const kept = weekAheadEarnings(many, WEEK, [], { max: 5 })
    expect(kept).toHaveLength(5)
    expect(kept[0].sym).toBe('S29')
  })
})

describe('the day-by-day rows', () => {
  const events = weekAheadEvents(
    [
      event('ISM Manufacturing PMI', '2026-11-02T15:00:00Z'),
      event('BoE Rate Decision', '2026-11-05T12:00:00Z', 'High', 'GBP'),
      event('Some Medium Thing', '2026-11-04T13:30:00Z', 'Medium'),
      event('Last Week CPI', '2026-10-28T12:30:00Z'), // outside the window
    ],
    WEEK,
  )

  it('keeps only the week, in time order', () => {
    expect(events.map(e => e.title)).toEqual(['ISM Manufacturing PMI', 'Some Medium Thing', 'BoE Rate Decision'])
  })

  it('gives every trading day a row, quiet ones included, with the London label', () => {
    const days = weekAheadDays(WEEK, events, [earning('AAPL', '2026-11-05', 3_900_000)], new Map([['AAPL', 'Apple Inc']]))
    expect(days.map(d => d.label)).toEqual(['Monday 2 November', 'Tuesday 3 November', 'Wednesday 4 November', 'Thursday 5 November', 'Friday 6 November'])
    expect(days[1].events).toEqual([])
    expect(days[3].earnings).toEqual([{ sym: 'AAPL', name: 'Apple Inc', time: 'post' }])
  })

  it('hands the writer verbatim fragments, and the weekday check holds the prose to them', () => {
    const days = weekAheadDays(WEEK, events, [earning('AAPL', '2026-11-05', 3_900_000)], new Map([['AAPL', 'Apple Inc']]))
    const facts = weekAheadFacts(days, ['The S&P 500 (SPY) last closed at 680.2, above its 20-day average (672.1) and above its 50-day average (660.4)'])
    expect(facts).toContain('Monday 15:00 UK — ISM Manufacturing PMI (USD, High impact): forecast 49.5 vs 48.7 previous')
    expect(facts).toContain('Apple Inc (AAPL) after the close')
    expect(facts).toContain('Tuesday 3 November: no high- or medium-impact US/UK data · no major earnings')
    expect(facts).toContain('quote these levels exactly')
    const { text } = correctTapeWeekdays('Wednesday brings the BoE Rate Decision.', weekAheadEventLines(days))
    expect(text).toBe('Thursday brings the BoE Rate Decision.')
  })
})

describe('a calendar that never reached the week', () => {
  it('reads "not published", never a quiet day', () => {
    expect(coversWeek(['2026-10-30'], WEEK)).toBe(false) // last week's feed, not yet rolled over
    expect(coversWeek(['2026-10-30', '2026-11-03'], WEEK)).toBe(true)
    const days = weekAheadDays(WEEK, [], [], new Map(), { events: false, earnings: true })
    const facts = weekAheadFacts(days, [])
    expect(facts).toContain('economic calendar NOT AVAILABLE')
    expect(facts).not.toContain('no high- or medium-impact')
    const html = buildNewspaperHtml({ headline: 'h', standfirst: 's', lead: 'l', tape: '', ideas: [], shortDesk: '', rotation: '', crypto: '', channels: '', editorial: '', honestClose: '', regime: 'amber', fedStance: 'neutral', macroNotes: [] }, 'Sunday', { weekAhead: days })
    expect(html).toContain('Calendar not yet published')
    expect(html).not.toContain('No major US/UK data')
  })
})

describe('index levels', () => {
  const candles = (closes: number[]) => closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }))

  it('says where the index closed against both averages', () => {
    const line = indexLevelLine('SPY', candles([...Array(49).fill(100), 110]))
    expect(line).toBe('SPY last closed at 110, above its 20-day average (100.5) and above its 50-day average (100.2)')
  })

  it('says nothing rather than guess on short history', () => {
    expect(indexLevelLine('SPY', candles(Array(30).fill(100)))).toBeNull()
    expect(indexLevelLine('SPY', null)).toBeNull()
  })
})

describe('the Sunday plan', () => {
  it('adds the week ahead and drops the 48-hour Tape on a week-ahead day', () => {
    const keys = (p: ReturnType<typeof planSections>) => [...p.wave1, ...p.wave2].map(s => s.key)
    const sunday = planSections({ shortsLive: false, weekAhead: true })
    expect(sunday.wave1.map(s => s.key)).toContain('weekAhead')
    expect(keys(sunday)).not.toContain('desk')
    const weekday = planSections({ shortsLive: true })
    expect(keys(weekday)).not.toContain('weekAhead')
    expect(keys(weekday).sort()).toEqual(SECTIONS.map(s => s.key).sort())
  })

  it('keeps the reader\'s own positions out of the brief', () => {
    expect(WEEK_AHEAD_SECTION.brief).toContain("Nothing about any individual reader's own positions")
  })
})

describe('the Sunday paper', () => {
  const report: ComposedReport = {
    headline: 'A Fed week', standfirst: 'Rates first.', lead: 'Lead.', tape: '', ideas: [], shortDesk: '', rotation: 'r', crypto: 'c',
    channels: 'ch', editorial: '', honestClose: 'h', regime: 'amber', fedStance: 'neutral', macroNotes: [],
    weekAhead: 'Posture paragraph.\n\nThe days that matter.',
  }
  const days = weekAheadDays(WEEK, [event('ISM Manufacturing PMI', '2026-11-02T15:00:00Z')], [earning('AAPL', '2026-11-05', 3_900_000)], new Map([['AAPL', 'Apple Inc']]))

  it('prints the preview and the day-by-day table, and not the 5-day calendar beside it', () => {
    const html = buildNewspaperHtml(report, 'Sunday 1 November 2026', { weekAhead: days, calendar: [event('ISM Manufacturing PMI', '2026-11-02T15:00:00Z')] })
    expect(html).toMatch(/<h2>The Week Ahead<\/h2>.*<p>Posture paragraph\.<\/p><p>The days that matter\.<\/p>/)
    expect(html).toContain('The Week Ahead — Day by Day')
    expect(html).toContain('Monday 2 November')
    expect(html).toContain('<b>AAPL</b> <span class="subtle">Apple Inc</span> <span class="subtle">· after the close</span>')
    expect(html).toContain('No major US/UK data') // Tuesday
    expect(html).not.toContain('On the Calendar')
  })

  it('leaves a weekday paper exactly as it was', () => {
    const html = buildNewspaperHtml({ ...report, weekAhead: undefined }, 'Monday 2 November 2026', { calendar: [event('ISM Manufacturing PMI', '2026-11-02T15:00:00Z')] })
    expect(html).not.toContain('The Week Ahead')
    expect(html).toContain('On the Calendar')
  })
})
