import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { DIP_CATALYST_KIND, VELOCITY_CATALYST_KIND } from './catalyst'
import { gradePrediction } from './calibration'
import { effectiveVelocityStop } from './velocityLane'
import { POSTMORTEM_CLASSES, classifyLoser, type PostMortemRow } from './postMortem'
import type { PredOutcome } from './types'

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)

/** Bar factory: closes drive every level check (grading is close-based), lows are
 * given separately where a fixture needs a specific dip floor. */
const tape = (closeAt: (i: number) => number, lowAt: (i: number) => number = i => closeAt(i) * 0.99): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    const l = lowAt(i)
    return { t: T0 + i * DAY, o: c, h: Math.max(c, l) * 1.01, l, c, v: 1_000_000 }
  })

const ENTRY_IDX = 30
const ENTRY = dateOf(ENTRY_IDX)

const flat = tape(() => 100)

const row = (over: Partial<PostMortemRow> = {}): PostMortemRow => ({
  side: 'long',
  date: ENTRY,
  stop: 90,
  ...over,
})

const outcome = (over: Partial<PredOutcome> = {}): PredOutcome => ({
  excessPct: -4,
  rawPct: -5,
  spyPct: 1,
  stopped: false,
  hit: false,
  ...over,
})

// A long that rides up to bar 34 and then collapses to 92 — under any trail the
// run drew, and still clear of the 80 stop by a mile.
const velocityTape = tape(i => (i <= ENTRY_IDX ? 100 + i : i <= 34 ? 100 + ENTRY_IDX + (i - ENTRY_IDX) * 4 : 92))

describe('classifyLoser — the pinned total order', () => {
  it('a STOPPED row that also beat the tape reads stopped, never market-drag', () => {
    // closes through 90 on bar 33, and the excess is POSITIVE: both classes are
    // true at once, and the order says which one gets to speak.
    const t = tape(i => (i < 33 ? 100 : 89))
    const { cls, detail } = classifyLoser(row(), outcome({ stopped: true, excessPct: 2.4, rawPct: -11, spyPct: -13.4 }), t)
    expect(cls).toBe('stopped')
    expect(detail).toContain('90')
    expect(detail).toContain(dateOf(33)) // the day it died, by name
  })

  it('a STOPPED velocity row whose trail also broke reads stopped — the stop outranks the trail', () => {
    const t = tape(i => (i <= ENTRY_IDX ? 100 + i : i <= 34 ? 130 + (i - ENTRY_IDX) * 4 : 79))
    const { cls } = classifyLoser(row({ stop: 80, trail: 'velocity', catalyst: { kind: VELOCITY_CATALYST_KIND, reason: 'first paid break' } }), outcome({ stopped: true }), t)
    expect(cls).toBe('stopped')
  })

  it('a VELOCITY row whose trail broke while the stop held reads thesis-break, naming the level and the day', () => {
    const r = row({ stop: 80, trail: 'velocity', catalyst: { kind: VELOCITY_CATALYST_KIND, reason: 'first paid break' } })
    const { cls, detail } = classifyLoser(r, outcome(), velocityTape)
    expect(cls).toBe('thesis-break')
    // the level is the RATCHETED trail as of the breaking session, not today's
    const broke = effectiveVelocityStop(80, velocityTape.slice(0, 36), ENTRY_IDX)
    expect(broke).toBeGreaterThan(80) // the fixture is only interesting if the trail rose
    expect(detail).toContain(String(broke))
    expect(detail).toContain('velocity trail')
    expect(detail).toContain(dateOf(35)) // the first close under it
    expect(detail).toContain('80') // …and the stop it never touched
  })

  it('a DIP row that closed under its dip low while the stop held reads thesis-break, naming the dip low', () => {
    // bars 20..(publication−1) bottom at 90 (the dip low); the PUBLICATION session
    // (entryIdx−1 — the engine publishes pre-open from bars strictly before the
    // entry) prints the lower low of 85, so the published stop sits UNDER the
    // structure — min(dip low, publication low). The basis matters: recomputing
    // on the ENTRY bar instead re-includes the 85 and suppresses this class
    // entirely (Task-2 review, Critical).
    const t = tape(
      i => (i < 33 ? 100 : 88),
      i => (i >= 20 && i < ENTRY_IDX - 1 ? 90 : i === ENTRY_IDX - 1 ? 85 : 95),
    )
    const { cls, detail } = classifyLoser(row({ stop: 85, catalyst: { kind: DIP_CATALYST_KIND, reason: 'dip 12% · holding: 4.1% above the 90 dip low' } }), outcome(), t)
    expect(cls).toBe('thesis-break')
    expect(detail).toContain('90')
    expect(detail).toContain('dip low')
    expect(detail).toContain(dateOf(33))
  })

  it('a dip row whose dip low IS its stop can never thesis-break — the structure and the falsifier are one level', () => {
    // no lower low on the entry session: stop === dip low, so a close through the
    // structure is a close through the stop and `stopped` already owns it.
    const t = tape(
      i => (i < 33 ? 100 : 88),
      i => (i >= 20 && i < ENTRY_IDX ? 90 : 95),
    )
    const { cls } = classifyLoser(row({ stop: 90, catalyst: { kind: DIP_CATALYST_KIND, reason: 'dip 12%' } }), outcome({ excessPct: -4 }), t)
    expect(cls).toBe('adverse-move')
  })

  it('a dip low the PUBLISHED window never contained stays uninvented — the wrong basis would fabricate it', () => {
    // The oldest published-window bar carries the 80 dip low; the entry-basis
    // window would DROP that bar and derive a 90 "level" no card ever showed.
    // Under the publication basis: dip low 80 == stop 80 → no second level →
    // the row reads adverse-move, never thesis-break-at-90.
    const t = tape(
      i => (i < 33 ? 100 : 89),
      i => (i === ENTRY_IDX - 11 ? 80 : i >= 20 && i < ENTRY_IDX ? 90 : 95),
    )
    const { cls, detail } = classifyLoser(row({ stop: 80, catalyst: { kind: DIP_CATALYST_KIND, reason: 'dip 12%' } }), outcome({ excessPct: -4 }), t)
    expect(cls).toBe('adverse-move')
    expect(detail).not.toContain('90')
  })

  it('a plain composite row NEVER thesis-breaks — no structural level, no claim to have lost one', () => {
    // the same collapsing tape as the velocity fixture, on a row that carries no
    // trail and no lane catalyst: the engine must not invent a level it never published.
    const { cls } = classifyLoser(row({ stop: 80 }), outcome(), velocityTape)
    expect(cls).toBe('adverse-move')
  })

  it('a SHORT stamped with the long-only velocity trail is left alone — max() would loosen forever', () => {
    const { cls } = classifyLoser(row({ side: 'short', stop: 120, trail: 'velocity' }), outcome(), velocityTape)
    expect(cls).not.toBe('thesis-break')
  })

  it('excess ≥ 0 reads market-drag ONLY when neither stop nor structure fired, and says it beat the tape', () => {
    const { cls, detail } = classifyLoser(row(), outcome({ excessPct: 0.6, rawPct: -2.1, spyPct: -2.7 }), flat)
    expect(cls).toBe('market-drag')
    expect(detail).toContain('0.6')
    expect(detail).toMatch(/beat the tape/)
    // the boundary is inclusive: dead level with the tape is still not adverse
    expect(classifyLoser(row(), outcome({ excessPct: 0 }), flat).cls).toBe('market-drag')
    expect(classifyLoser(row(), outcome({ excessPct: -0.1 }), flat).cls).toBe('adverse-move')
  })

  it('the fallback carries the raw numbers so nobody has to open the ledger to read the loss', () => {
    const { cls, detail } = classifyLoser(row(), outcome({ excessPct: -6.6, rawPct: -5.2, spyPct: 1.4 }), flat)
    expect(cls).toBe('adverse-move')
    expect(detail).toContain('-5.2')
    expect(detail).toContain('1.4')
    expect(detail).toContain('-6.6')
  })

  it('news-reversal is NEVER assigned deterministically — the LLM pass is its only door', () => {
    const rows: PostMortemRow[] = [
      row(),
      row({ side: 'short', stop: 120 }),
      row({ stop: 80, trail: 'velocity', catalyst: { kind: VELOCITY_CATALYST_KIND, reason: 'r' } }),
      row({ catalyst: { kind: DIP_CATALYST_KIND, reason: 'r' } }),
      row({ catalyst: { kind: 'news', reason: 'tone flipped hard' } }),
    ]
    const outs = [outcome(), outcome({ stopped: true }), outcome({ excessPct: 0.4 }), outcome({ excessPct: -20 })]
    for (const r of rows)
      for (const o of outs)
        for (const t of [flat, velocityTape]) expect(classifyLoser(r, o, t).cls).not.toBe('news-reversal')
    expect(POSTMORTEM_CLASSES).toContain('news-reversal') // …but the class exists for Task 3 to reach
  })

  it('fails soft on a tape that never reaches the call date: a class, never a throw', () => {
    const short = flat.slice(0, 5) // ends long before the entry session
    expect(classifyLoser(row(), outcome({ stopped: true }), short).cls).toBe('stopped')
    expect(classifyLoser(row({ trail: 'velocity', stop: 80 }), outcome(), short).cls).toBe('adverse-move')
    expect(classifyLoser(row({ date: 'not-a-date' }), outcome(), flat).cls).toBe('adverse-move')
    expect(classifyLoser(row(), outcome(), []).cls).toBe('adverse-move')
  })

  it('agrees with gradePrediction about what "stopped" means — close-based, entry session included', () => {
    // the tape closes UNDER the stop on the entry session itself: grading calls it
    // stopped, and so must the post-mortem's own walk (session 1, not "no day").
    const t = tape(i => (i < ENTRY_IDX ? 100 : 89))
    const pred = { date: ENTRY, side: 'long' as const, priceAtPrediction: 100, stop: 90 }
    const o = gradePrediction(pred, t, flat, 10)!
    expect(o.stopped).toBe(true)
    const { detail } = classifyLoser(row(), o, t)
    expect(detail).toContain(dateOf(ENTRY_IDX))
    expect(detail).toContain('session 1')
  })
})
