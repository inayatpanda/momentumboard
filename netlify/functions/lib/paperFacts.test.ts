import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { companyNamesBlock, correctTapeWeekdays, honestCloseFacts, lockCompanyNames, shortDeskData, shortDeskScope, shortsLive, tapeEventLines } from './paperFacts'
import { buildNewspaperHtml, paperPostMortems, planSections, sectionPrompt, SECTIONS, SHORT_DESK_EMPTY, type CalendarRow, type ComposedReport, type PaperPostMortem } from './newspaper'
import { plausibleCapUsdM } from './social'
import type { Prediction } from '../../../shared/engine/types'

// THE FOUR REAL DEFECTS (editions 2026-08-13..16). Every one of them is the same
// failure: the deterministic sections named the company correctly two sections
// up, and the prose invented a different one against the same ticker.
describe('lockCompanyNames — the prose may not rename a company', () => {
  const names = new Map([
    ['CRWV', 'CoreWeave Inc'],
    ['EFOR', 'Everforth Inc'],
    ['AYA', 'Aya Gold & Silver Inc'],
    ['GOLD', 'Barrick Gold Corporation'],
  ])

  it('replaces an invented name bound to a known ticker', () => {
    const { text, fixes } = lockCompanyNames('CrowdWave Technologies (CRWV) is the AI landlord of the moment.', names)
    expect(text).toBe('CoreWeave Inc (CRWV) is the AI landlord of the moment.')
    expect(fixes).toEqual([{ sym: 'CRWV', from: 'CrowdWave Technologies', to: 'CoreWeave Inc' }])
  })

  it('replaces a mangled name — Efor Global Inc for Everforth (EFOR)', () => {
    expect(lockCompanyNames('Watch Efor Global Inc (EFOR) into the print.', names).text).toBe('Watch Everforth Inc (EFOR) into the print.')
  })

  it('replaces a name that is right in shape and wrong in fact — Aya Gold & Copper', () => {
    expect(lockCompanyNames('Aya Gold & Copper (AYA) is up 40%.', names).text).toBe('Aya Gold & Silver Inc (AYA) is up 40%.')
  })

  it('fixes the ticker-first form the board and radar use — SYM · Name', () => {
    expect(lockCompanyNames('GOLD · Gold.com Inc prints Thursday.', names).text).toBe('GOLD · Barrick Gold Corporation prints Thursday.')
    expect(lockCompanyNames('GOLD (Gold.com Inc) prints Thursday.', names).text).toBe('GOLD (Barrick Gold Corporation) prints Thursday.')
  })

  it('leaves a shorter or longer TRUE form of the same name alone', () => {
    // the writer may say "CoreWeave" where the register says "CoreWeave Inc" —
    // that is house style, not an invention, and rewriting it would make the
    // prose read like a filings index
    for (const ok of ['CoreWeave (CRWV) leads.', 'CoreWeave Inc (CRWV) leads.', 'Barrick Gold Corp (GOLD) prints.', 'Aya Gold & Silver (AYA) is up.']) {
      expect(lockCompanyNames(ok, names).text).toBe(ok)
    }
    expect(lockCompanyNames('CoreWeave (CRWV) leads.', names).fixes).toEqual([])
  })

  it('never touches a ticker it has no canonical name for', () => {
    const src = 'Whatever Holdings (ZZZZ) is a name the register has never heard of.'
    expect(lockCompanyNames(src, names).text).toBe(src)
  })

  it('drops the sentence verb it cannot own — the trailing name is what gets replaced', () => {
    // "Buy" is not part of any company name; the replacement must not eat the
    // sentence around it or leave a half-name behind
    expect(lockCompanyNames('Buy CrowdWave Technologies (CRWV) here.', names).text).toBe('Buy CoreWeave Inc (CRWV) here.')
  })

  it('never swallows the clause in front of the name it is fixing', () => {
    const { text } = lockCompanyNames('The AI trade found its landlord in CrowdWave Technologies (CRWV) this week.', names)
    expect(text).toContain('The AI trade found its landlord in')
    expect(text).toContain('CoreWeave Inc (CRWV)')
    expect(text).not.toContain('CrowdWave')
  })

  it('is a no-op on prose with no ticker bindings at all', () => {
    const src = 'The tape was thin and the rotation held. Nothing to rename here.'
    expect(lockCompanyNames(src, names).text).toBe(src)
  })
})

describe('companyNamesBlock — the register the prompt is handed', () => {
  it('prints one verbatim pair per ticker with the never-invent instruction', () => {
    const block = companyNamesBlock(new Map([['CRWV', 'CoreWeave Inc'], ['GOLD', 'Barrick Gold Corporation']]))
    expect(block).toContain('NAMES — use these exactly, never invent or vary')
    expect(block).toContain('CRWV = CoreWeave Inc')
    expect(block).toContain('GOLD = Barrick Gold Corporation')
  })

  it('is empty when nothing is known — an empty register must not print an empty promise', () => {
    expect(companyNamesBlock(new Map())).toBe('')
  })
})

// THE SUNDAY OFF-BY-ONE (2026-08-16 edition). The calendar TABLE said Tue 07:00
// and Wed 13:30; the Tape, three inches above it, said "Monday brings UK Claimant
// Count… Tuesday CPI + FOMC". The table was right both times — the narrative had
// re-derived the weekdays from the dates and drifted one day.
const CAL: CalendarRow[] = [
  { title: 'Claimant Count Change', country: 'GBP', at: 1_787_032_800, impact: 'High', forecast: '18.7K', previous: '25.9K' },
  { title: 'CPI m/m', country: 'USD', at: 1_787_142_600, impact: 'High', forecast: '0.3%', previous: '0.2%' },
  { title: 'FOMC Statement', country: 'USD', at: 1_787_162_400, impact: 'High' },
]

describe('tapeEventLines — the fragments the Tape is handed instead of dates', () => {
  it('renders weekday, time, name and forecast/previous exactly as the table does', () => {
    const [claimant, cpi, fomc] = tapeEventLines(CAL)
    expect(claimant.weekday).toBe('Tuesday')
    expect(claimant.time).toBe('07:00')
    expect(claimant.line).toBe('Tuesday 07:00 UK — Claimant Count Change (GBP, High impact): forecast 18.7K vs 25.9K previous')
    expect(cpi.weekday).toBe('Wednesday')
    expect(cpi.line).toContain('Wednesday 13:30 UK — CPI m/m')
    // no forecast published → the fragment says so rather than inventing one
    expect(fomc.line).toBe('Wednesday 19:00 UK — FOMC Statement (USD, High impact): no forecast published')
  })

  it('carries no epoch and no ISO date — there is nothing left to re-derive a weekday from', () => {
    for (const e of tapeEventLines(CAL)) {
      expect(e.line).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(e.line).not.toContain('1787')
    }
  })

  it("caps at the table's own six rows and survives an empty calendar", () => {
    expect(tapeEventLines([])).toEqual([])
    expect(tapeEventLines([...CAL, ...CAL, ...CAL])).toHaveLength(6)
  })
})

describe('correctTapeWeekdays — the Tape cannot disagree with its own table', () => {
  it('fixes the real Sunday off-by-one, in place, both events', () => {
    const tape =
      "Monday brings UK Claimant Count Change, and the print is the week's first real test. " +
      'Tuesday delivers CPI, with the FOMC statement the same evening.'
    const { text, fixes } = correctTapeWeekdays(tape, tapeEventLines(CAL))
    expect(text).toBe(
      "Tuesday brings UK Claimant Count Change, and the print is the week's first real test. " +
        'Wednesday delivers CPI, with the FOMC statement the same evening.',
    )
    expect(fixes.map(f => `${f.from}->${f.to}`)).toEqual(['Monday->Tuesday', 'Tuesday->Wednesday'])
  })

  it('fixes the abbreviated form in the abbreviated form', () => {
    expect(correctTapeWeekdays('CPI lands Tue at 13:30.', tapeEventLines(CAL)).text).toBe('CPI lands Wed at 13:30.')
  })

  it('leaves a Tape that already agrees with the table byte-identical', () => {
    const ok = 'Tuesday 07:00 UK brings Claimant Count Change; Wednesday 13:30 UK brings CPI m/m and the FOMC Statement at 19:00.'
    const { text, fixes } = correctTapeWeekdays(ok, tapeEventLines(CAL))
    expect(text).toBe(ok)
    expect(fixes).toEqual([])
  })

  it('never touches a weekday that is not talking about a calendar event', () => {
    const prose = 'Monday was quiet and the tape went nowhere at all, which is its own kind of information for a reader.'
    expect(correctTapeWeekdays(prose, tapeEventLines(CAL)).text).toBe(prose)
  })

  it('is a no-op with no events — an empty calendar corrects nothing', () => {
    expect(correctTapeWeekdays('Monday brings CPI.', []).text).toBe('Monday brings CPI.')
  })
})

// THE CIRCULAR CLOSE. "The TSLA short call lost money because the trade was
// stopped out" is not an explanation — it is the outcome, restated. The engine
// had written the real one at grading time and the composer was never shown it.
describe('honestCloseFacts — the close answers for the newest loss, in the engine\'s words', () => {
  const losses: PaperPostMortem[] = [
    {
      date: '2026-08-11',
      sym: 'TSLA',
      side: 'short',
      cls: 'stopped',
      excessPct: -6.6,
      why: 'Gapped through the stop on an unscheduled guidance cut — nothing in the setup priced that.',
      via: 'llm',
    },
    { date: '2026-07-30', sym: 'IONQ', side: 'long', cls: 'adverse-move', excessPct: -4.1, why: 'Drifted against us with no level broken.' },
  ]

  it('names the freshest sized loss with its date and excess, and quotes the post-mortem VERBATIM', () => {
    const block = honestCloseFacts(losses)
    expect(block).toContain('TSLA short')
    expect(block).toContain('2026-08-11')
    expect(block).toContain('-6.6pp')
    expect(block).toContain('"Gapped through the stop on an unscheduled guidance cut — nothing in the setup priced that."')
  })

  it('does not offer the older loss the paper kept reaching for', () => {
    const block = honestCloseFacts(losses)
    expect(block).not.toContain('2026-07-30')
    expect(block).not.toContain('IONQ')
  })

  it('forbids the circular sentence by name', () => {
    const block = honestCloseFacts(losses)
    expect(block.toLowerCase()).toContain('never explain a loss with the fact that it lost')
    expect(block).toContain('stopped out') // the exact phrase the paper kept printing, quoted as the thing not to write
  })

  it('says so honestly when nothing has been lost — and offers nothing to reach for', () => {
    const block = honestCloseFacts([])
    expect(block).toContain('no sized call has been graded a loss')
    expect(block).not.toContain('VERBATIM')
    expect(block.toLowerCase()).toContain('do not reach back')
  })

  it('an excess the grader never wrote is simply absent — never a zero', () => {
    const block = honestCloseFacts([{ date: '2026-08-11', sym: 'TSLA', side: 'short', cls: 'stopped', why: 'The level went.' }])
    expect(block).toContain('TSLA short')
    expect(block).not.toContain('0pp')
    expect(block).not.toContain('undefined')
  })

  it('carries today\'s experiment beside it, hypothesis and warning verbatim', () => {
    const block = honestCloseFacts(losses, {
      label: 'THE WILDCARD',
      sym: 'WILD',
      gate: 'expected-move',
      hypothesis: 'expected-move has 0 priced outcomes',
      warning: 'Experiments lose more often than calls.',
    })
    expect(block).toContain('THE WILDCARD')
    expect(block).toContain('expected-move has 0 priced outcomes')
    expect(block).toContain('Experiments lose more often than calls.')
  })
})

// THE SHORT DESK KEPT WANDERING. Sunday's filled with long-side watch names,
// sector-rotation copy and a "small-cap discovery from Friday" that Friday's own
// Small-Cap Wire never made — because the section was written from the whole
// 28KB data document, where every one of those things was sitting.
describe('the short desk is written from the short side, or not at all', () => {
  const board = [
    { sym: 'AMD', side: 'short' as const, grade: 'B' as const, riskPct: 1, note: 'weak, below the 50-day' },
    { sym: 'NVDA', side: 'short' as const, grade: 'A' as const, riskPct: 0, watchOnly: true, observation: true, note: 'no ISA route — observation only' },
    { sym: 'PLTR', side: 'short' as const, nearMiss: true, watchOnly: true, note: 'closest thing to a short' },
    { sym: 'ABBV', side: 'long' as const, grade: 'A' as const, riskPct: 1, note: 'pullback into support' },
    { sym: 'HTZ', side: 'long' as const, watchOnly: true, note: 'the long-side watch name that kept turning up on the short desk' },
  ]

  it('scopes to short-side rows and short-side near misses — nothing else survives', () => {
    const scope = shortDeskScope(board)
    expect(scope.shorts.map(r => r.sym)).toEqual(['AMD', 'NVDA'])
    expect(scope.nearMisses.map(r => r.sym)).toEqual(['PLTR'])
    expect(JSON.stringify(scope)).not.toContain('ABBV')
    expect(JSON.stringify(scope)).not.toContain('HTZ')
  })

  it('the section prompt it is written from cannot reach a long name or a sector table', () => {
    const spec = SECTIONS.find(s => s.key === 'shorts')!
    const prompt = sectionPrompt(spec, shortDeskData(shortDeskScope(board)), 'Sunday, 16 August 2026')
    expect(prompt).toContain('AMD')
    expect(prompt).not.toContain('ABBV')
    expect(prompt).not.toContain('HTZ')
    // …and the data document behind it carries two keys, not the paper's whole
    // 28KB world (the persona's own prose names some of these keys — as things
    // never to print — so the check belongs on the data, where the leak was)
    const data = shortDeskData(shortDeskScope(board))
    for (const leak of ['sectorRotation', 'socialPulse', 'rotationLeaders', 'candidateReads', 'channelConsensus', 'mediaHeadlines', 'previousEditions']) {
      expect(data).not.toContain(leak)
    }
    expect(Object.keys(JSON.parse(data))).toEqual(['shortBoard', 'shortNearMisses'])
    expect(spec.brief).toContain('SHORT SIDE ONLY')
    expect(spec.fields).toEqual(['shortDesk'])
  })

  it("the ideas desk no longer writes the short desk — one section, one input", () => {
    const ideas = SECTIONS.find(s => s.key === 'ideas')!
    expect(ideas.fields).toEqual(['ideas'])
    expect(ideas.shape).not.toContain('shortDesk')
  })

  it('an empty short side is written by the desk itself — the model is never called', () => {
    const empty = shortDeskScope(board.filter(r => r.side === 'long'))
    expect(shortsLive(empty)).toBe(false)
    const plan = planSections({ shortsLive: false })
    expect([...plan.wave1, ...plan.wave2].map(s => s.key)).not.toContain('shorts')
    expect(plan.fixed.shortDesk).toBe(SHORT_DESK_EMPTY)
  })

  it('…and a live short side is written by the model, in wave two, knowing what the ideas desk took', () => {
    expect(shortsLive(shortDeskScope(board))).toBe(true)
    const plan = planSections({ shortsLive: true })
    expect(plan.wave1.map(s => s.key)).not.toContain('shorts') // wave 2: it must see the covered list
    expect(plan.wave2.map(s => s.key)).toContain('shorts')
    expect(plan.fixed.shortDesk).toBeUndefined()
    expect([...plan.wave1, ...plan.wave2].map(s => s.key).sort()).toEqual(SECTIONS.map(s => s.key).sort())
  })

  it('a near miss alone still earns a desk — "nothing cleared, the closest was X" is worth a line', () => {
    expect(shortsLive(shortDeskScope([board[2]]))).toBe(true)
  })
})

// ---- W5: the mechanical noise a reader sees before they read a word ----

const page: ComposedReport = {
  headline: 'Tech Leads a Cautious Tape Higher',
  standfirst: 'Rotation into growth firms up while the short week keeps volumes thin.',
  lead: 'First paragraph.',
  tape: 'SPY above both averages.',
  ideas: [
    {
      ticker: 'HTZ', side: 'long', playbook: 'R', caseText: 'Base reclaim on volume.',
      entry: '5.40', invalidation: '4.90', target: '7.10', conviction: 'B',
      reasons: ['1. Hertz has outperformed the rental complex for three weeks', '2) Volume confirmed the reclaim', 'Insiders bought in size'],
    },
  ],
  shortDesk: 'One clean fade.',
  rotation: 'Money into tech.',
  crypto: 'BTC holding.',
  channels: 'Josh cautious.',
  editorial: 'In 1999 the same rotation ran ahead of the melt-up, and the discipline that survived it was not conviction but position size. Every generation relearns that lesson the expensive way.',
  honestClose: 'Confidence B.',
  regime: 'green',
  fedStance: 'neutral',
  macroNotes: [],
}

describe('the numbered reasons are numbered once', () => {
  it('strips the model\'s own numbering before the template applies its own', () => {
    const html = buildNewspaperHtml(page, 'Sunday, 16 August 2026')
    expect(html).toContain('1) Hertz has outperformed the rental complex for three weeks')
    expect(html).toContain('2) Volume confirmed the reclaim')
    expect(html).not.toContain('1) 1.')
    expect(html).not.toContain('2) 2)')
    expect(html).toContain('3) Insiders bought in size') // an unnumbered reason is untouched
  })
})

describe('the pull-quote is not the sentence the reader is about to read', () => {
  it('takes a LATER sentence of The Long View, never its opening', () => {
    const html = buildNewspaperHtml(page, 'Sunday, 16 August 2026')
    const opening = 'In 1999 the same rotation ran ahead of the melt-up, and the discipline that survived it was not conviction but position size.'
    expect(html.split(opening).length - 1).toBe(1) // printed once, in The Long View
    expect(html).toContain('class="pull"')
    expect(html).toContain('Every generation relearns that lesson the expensive way.')
  })

  it('drops the quote block entirely when The Long View has only that one sentence to give', () => {
    const oneSentence = { ...page, editorial: 'In 1999 the same rotation ran ahead of the melt-up, and the discipline that survived it was position size.' }
    const html = buildNewspaperHtml(oneSentence, 'Sunday, 16 August 2026')
    expect(html).not.toContain('class="pull"')
    expect(html.split(oneSentence.editorial).length - 1).toBe(1)
  })

  it('…and never falls back to reprinting the standfirst either', () => {
    const noEditorial = { ...page, editorial: '' }
    const html = buildNewspaperHtml(noEditorial, 'Sunday, 16 August 2026')
    expect(html).not.toContain('class="pull"')
    // twice only: the og:description meta and the standfirst itself — never a
    // third time as a quote block
    expect(html.split(page.standfirst).length - 1).toBe(2)
  })
})

describe('an implausible market cap is a missing market cap', () => {
  it('the MU defect: $1072.7B for a name worth a tenth of that renders as the empty state', () => {
    const html = buildNewspaperHtml(page, 'Sunday, 16 August 2026', {
      socialBoard: [
        { sym: 'MU', redditRank: 3, redditMentions: 210, surgeMultiple: 2.1, sources: 2, capUsdM: 1_072_700 },
        { sym: 'IONQ', redditRank: 1, redditMentions: 842, surgeMultiple: 3.1, sources: 2, capUsdM: 9_000 },
      ],
    })
    expect(html).not.toContain('1072.7B')
    expect(html).toContain('$9.0B') // the plausible one is untouched
  })

  it('the guard itself: a trillion on the wrong name, anything above $5T, and any non-number', () => {
    expect(plausibleCapUsdM(9_000, 'IONQ')).toBe(9_000)
    expect(plausibleCapUsdM(120_000, 'MU')).toBe(120_000) // MU's real order of magnitude survives
    expect(plausibleCapUsdM(4_100_000, 'AAPL')).toBe(4_100_000) // a real trillion-dollar name survives
    expect(plausibleCapUsdM(1_072_700, 'MU')).toBeNull() // the defect: $1.07T for a $120B name
    expect(plausibleCapUsdM(1_072_700)).toBe(1_072_700) // …and with no symbol only the hard bound can speak
    expect(plausibleCapUsdM(5_000_001, 'AAPL')).toBeNull() // nobody, ever
    expect(plausibleCapUsdM(1_072_700 * 1000, 'MU')).toBeNull() // the unit-mismatch signature
    expect(plausibleCapUsdM(0, 'MU')).toBeNull()
    expect(plausibleCapUsdM(-5, 'MU')).toBeNull()
    expect(plausibleCapUsdM(null)).toBeNull()
    expect(plausibleCapUsdM(undefined)).toBeNull()
    expect(plausibleCapUsdM(Number.NaN)).toBeNull()
  })
})

// The compose handler runs inside a Netlify background function against live
// blobs, so the wiring is pinned where it lives: in the source. Each of these is
// a promise the pure functions above cannot keep on their own — a post-pass that
// runs before a model rewrites the prose is a post-pass that does nothing.
describe('the compose handler actually wires the deterministic passes', () => {
  const src = readFileSync(join(process.cwd(), 'netlify', 'functions', 'report-compose-background.mts'), 'utf8')

  it('hands the writers event FRAGMENTS, never the raw calendar dates', () => {
    expect(src).toContain('const tapeEvents = tapeEventLines(calendarRows)')
    expect(src).toContain('calendar: calendarRows') // the table and the fragments share ONE array
    expect(src).toContain('eventSchedule: tapeEvents.map(e => e.line)')
    expect(src).not.toContain('econCalendarThisWeek') // the epoch-carrying key is gone
  })

  it('runs the weekday correction and the name lock AFTER the audit and freshness rewrites', () => {
    const lock = src.indexOf('lockCompanyNames(s, companyNames)')
    const weekdays = src.indexOf('correctTapeWeekdays(composed.tape, tapeEvents)')
    const build = src.indexOf('buildNewspaperHtml(composed, dateLabel, extras)')
    const freshness = src.indexOf('findVerbatimRepeats')
    const audit = src.indexOf('claims audit')
    for (const after of [lock, weekdays]) {
      expect(after).toBeGreaterThan(freshness)
      expect(after).toBeGreaterThan(audit)
      expect(after).toBeLessThan(build)
    }
  })

  it('builds the company register BEFORE composing, and the ideas read the same one', () => {
    expect(src.indexOf('const companyNames = await')).toBeLessThan(src.indexOf('const writeSection = async'))
    expect(src).toContain('companyNamesBlock(companyNames)')
    expect(src).toContain('const canonical = companyNames.get(i.ticker)')
  })

  it('gives the honest close its loss facts and the short desk its own data', () => {
    expect(src).toContain("honestCloseFacts(postMortems ?? [], wildcard)")
    expect(src).toContain("key === 'voice' ? closeFacts : ''")
    expect(src).toContain("const dataFor = (key: string) => (key === 'shorts' ? shortsJson : data)")
    expect(src).toContain('planSections({ shortsLive: shortsOn, weekAhead: !!weekDays })')
  })

  it('keeps the desk-written empty line out of the freshness rewrite', () => {
    expect(src).toContain('composed.shortDesk === SHORT_DESK_EMPTY ? undefined : composed.shortDesk')
  })
})

describe('paperPostMortems — the loss the close is written from carries its number', () => {
  const graded = (over: Partial<Prediction>): Prediction =>
    ({
      id: '2026-08-11:TSLA:short', date: '2026-08-11', sym: 'TSLA', side: 'short', riskPct: 1,
      postMortem: { cls: 'stopped', detail: 'Stop at 340 went on the guidance cut.', at: 1_787_000_000, sentence: 'Gapped through the stop on an unscheduled guidance cut.' },
      outcome10: { excessPct: -6.6, rawPct: -7.1, spyPct: -0.5, stopped: true, hit: false },
      ...over,
    }) as Prediction

  it('carries the graded excess beside the sentence, so the close can state what it cost', () => {
    const [row] = paperPostMortems([{ date: '2026-08-11', preds: [graded({})] }])
    expect(row.excessPct).toBe(-6.6)
    expect(row.why).toBe('Gapped through the stop on an unscheduled guidance cut.')
  })

  it('falls back to the 5-session grade, and leaves the number absent when neither exists', () => {
    const five = graded({ outcome10: undefined, outcome5: { excessPct: -3.2, rawPct: -3.2, spyPct: 0, stopped: true, hit: false } })
    expect(paperPostMortems([{ date: '2026-08-11', preds: [five] }])[0].excessPct).toBe(-3.2)
    const none = graded({ outcome10: undefined })
    expect(paperPostMortems([{ date: '2026-08-11', preds: [none] }])[0].excessPct).toBeUndefined()
  })
})
