import { describe, expect, it, vi } from 'vitest'
import {
  annotatePostMortems,
  parsePostMortemReply,
  postMortemPrompt,
  sentenceOrder,
  POSTMORTEM_LLM_BUDGET,
  POSTMORTEM_SENTENCE_MAX_CHARS,
  type PostMortemAsk,
} from './postMortemLlm'
import type { PostMortem, PostMortemClass } from '../../../shared/engine/postMortem'

// ---- fixtures ----

const pm = (cls: PostMortemClass, detail: string): PostMortem => ({ cls, detail, at: 1_700_000_000 })

const ask = (over: Partial<PostMortemAsk> = {}): PostMortemAsk => ({
  sym: 'ACME',
  side: 'long',
  date: '2026-08-03',
  setup: 'continuation',
  entry: 100,
  stop: 92.5,
  target: 118,
  thesis: 'the base broke on real volume and the sector is bid',
  falsifier: 'a close back under 92.5',
  catalyst: { kind: 'dip', reason: 'sold off with the chip complex, buyers back at the low' },
  outcome: { rawPct: -8.4, spyPct: 1.2, excessPct: -9.6, stopped: true, hit: false },
  postMortem: pm('stopped', 'closed through the 92.5 stop on 2026-08-07 (session 3) — -8.4% vs SPY +1.2%, excess -9.6pp'),
  ...over,
})

const reply = (sentence: string, flip: unknown = false) => JSON.stringify({ sentence, catalystFlip: flip })

describe('postMortemPrompt — the model is handed the deterministic read, not asked to replace it', () => {
  it('carries the class, the thesis, the falsifier and every number the sentence may use', () => {
    const p = postMortemPrompt(ask())
    expect(p).toContain('ACME')
    expect(p).toContain('stopped') // the deterministic class
    expect(p).toContain('the base broke on real volume') // thesis
    expect(p).toContain('a close back under 92.5') // falsifier
    expect(p).toContain('100') // entry
    expect(p).toContain('92.5') // stop
    expect(p).toContain('-9.6') // excess
    expect(p).toContain('sold off with the chip complex') // the catalyst it may judge a flip against
    // the two rails: no invented facts, and no live news to guess from
    expect(p).toMatch(/ONLY the facts above/i)
    expect(p).toMatch(/no live news/i)
    expect(p).toContain('"catalystFlip"')
  })

  it('says plainly when a row carried no thesis or catalyst rather than leaving a blank the model can fill', () => {
    const p = postMortemPrompt(ask({ thesis: undefined, falsifier: undefined, catalyst: null }))
    expect(p).toMatch(/not recorded/)
    expect(p).toMatch(/CATALYST: none/)
  })
})

describe('parsePostMortemReply — an upgrade needs an affirmation, not a hint', () => {
  it('takes a well-formed sentence, fenced or bare', () => {
    expect(parsePostMortemReply(reply('It gave back the breakout and stopped out three sessions in.'))?.sentence).toBe(
      'It gave back the breakout and stopped out three sessions in.',
    )
    expect(parsePostMortemReply('```json\n{"sentence":"Stopped out.","catalystFlip":false}\n```')?.sentence).toBe('Stopped out.')
  })

  it('flips ONLY on a literal affirmation — every ambiguity reads false', () => {
    expect(parsePostMortemReply(reply('s', true))?.flip).toBe(true)
    expect(parsePostMortemReply(reply('s', 'true'))?.flip).toBe(true)
    for (const v of [false, 'maybe', 'unclear', 'possibly true', 1, null, undefined, 'TRUE-ish'])
      expect(parsePostMortemReply(reply('s', v))?.flip).toBe(false)
  })

  it('is null on anything that is not a usable sentence — prose, empty JSON, a blank sentence, junk', () => {
    expect(parsePostMortemReply('The stock went down, sorry.')).toBeNull()
    expect(parsePostMortemReply('{"catalystFlip":true}')).toBeNull()
    expect(parsePostMortemReply(reply('   '))).toBeNull()
    expect(parsePostMortemReply('')).toBeNull()
    expect(parsePostMortemReply('{ not json')).toBeNull()
  })

  it('collapses whitespace and clips a model that wrote an essay', () => {
    const long = `x${'y'.repeat(500)}`
    const parsed = parsePostMortemReply(reply(`  two   spaces\nand a newline  `))!
    expect(parsed.sentence).toBe('two spaces and a newline')
    expect(parsePostMortemReply(reply(long))!.sentence.length).toBeLessThanOrEqual(POSTMORTEM_SENTENCE_MAX_CHARS)
  })
})

describe('sentenceOrder — newest first, and the worst loss of the newest day first', () => {
  it('orders by date descending, then by excess ascending, then by symbol', () => {
    const rows = [
      ask({ sym: 'OLD', date: '2026-08-01', outcome: { rawPct: -1, spyPct: 0, excessPct: -1, stopped: false, hit: false } }),
      ask({ sym: 'MILD', date: '2026-08-03', outcome: { rawPct: -2, spyPct: 0, excessPct: -2, stopped: false, hit: false } }),
      ask({ sym: 'WORST', date: '2026-08-03', outcome: { rawPct: -20, spyPct: 0, excessPct: -20, stopped: true, hit: false } }),
    ]
    expect(sentenceOrder(rows).map(r => r.sym)).toEqual(['WORST', 'MILD', 'OLD'])
    // and it is a copy: the caller's array is never re-ordered under it
    expect(rows.map(r => r.sym)).toEqual(['OLD', 'MILD', 'WORST'])
  })
})

describe('annotatePostMortems — the budget, the floor and the one upgrade path', () => {
  const day = (sym: string, date: string, over: Partial<PostMortemAsk> = {}) => ask({ sym, date, ...over })

  it('spends at most POSTMORTEM_LLM_BUDGET calls, newest first, and MARKS the overflow instead of silently skipping it', async () => {
    const rows = [
      day('E', '2026-08-01'),
      day('D', '2026-08-02'),
      day('C', '2026-08-03'),
      day('B', '2026-08-04'),
      day('A', '2026-08-05'),
    ]
    const llm = vi.fn(async () => reply('one plain sentence'))
    const stat = await annotatePostMortems(rows, llm)

    expect(llm).toHaveBeenCalledTimes(POSTMORTEM_LLM_BUDGET)
    expect(stat).toMatchObject({ asked: 3, written: 3, upgraded: 0, overflow: 2 })
    // the three newest carry a sentence…
    for (const sym of ['A', 'B', 'C']) {
      const r = rows.find(x => x.sym === sym)!
      expect(r.postMortem.sentence).toBe('one plain sentence')
      expect(r.postMortem.via).toBe('llm')
    }
    // …and the two the budget could not reach say SO — a marker, never a sentence
    for (const sym of ['D', 'E']) {
      const r = rows.find(x => x.sym === sym)!
      expect(r.postMortem.via).toBe('budget')
      expect(r.postMortem.sentence).toBeUndefined()
      expect(r.postMortem.detail).toContain('stop') // the deterministic line, untouched
    }
  })

  it('upgrades to news-reversal ONLY on an affirmed flip — and keeps the deterministic class in the detail', async () => {
    const row = day('FLIP', '2026-08-05')
    const before = row.postMortem.detail
    const stat = await annotatePostMortems([row], async () => reply('The takeover talk was denied and the name gave it all back.', true))

    expect(stat.upgraded).toBe(1)
    expect(row.postMortem.cls).toBe('news-reversal')
    expect(row.postMortem.detail).toContain('stopped') // the original class, kept
    expect(row.postMortem.detail).toContain(before) // and the original numbers with it
    expect(row.postMortem.sentence).toContain('takeover talk was denied')
  })

  it('leaves the deterministic class standing on an ambiguous answer — the sentence is still kept', async () => {
    const row = day('HEDGE', '2026-08-05')
    const stat = await annotatePostMortems([row], async () => reply('Possibly news-driven, hard to say.', 'maybe'))

    expect(stat.upgraded).toBe(0)
    expect(row.postMortem.cls).toBe('stopped')
    expect(row.postMortem.sentence).toBe('Possibly news-driven, hard to say.')
  })

  it('a thrown call cannot lose the deterministic line, is never retried, and stands the rest of the run down', async () => {
    const rows = [day('A', '2026-08-05'), day('B', '2026-08-04'), day('C', '2026-08-03')]
    const detailBefore = rows.map(r => r.postMortem.detail)
    const llm = vi.fn(async () => {
      throw new Error('groq HTTP 429: rate_limit_exceeded')
    })
    const stat = await annotatePostMortems(rows, llm)

    // ONE attempt in total: callLlm has already tried every configured provider
    // before it throws, so a second ask this run cannot succeed
    expect(llm).toHaveBeenCalledTimes(1)
    expect(stat).toMatchObject({ asked: 1, written: 0, upgraded: 0 })
    expect(rows.map(r => r.postMortem.detail)).toEqual(detailBefore)
    expect(rows[0].postMortem.via).toBe('failed')
    expect(rows[0].postMortem.sentence).toBeUndefined()
    // the two never asked carry no marker at all: absence is the honest record of
    // a question nobody got to put
    expect(rows[1].postMortem.via).toBeUndefined()
    expect(rows[2].postMortem.via).toBeUndefined()
  })

  it('an unusable answer costs its budget slot, is marked, and does not stop the next row', async () => {
    const rows = [day('A', '2026-08-05'), day('B', '2026-08-04')]
    let n = 0
    const llm = vi.fn(async () => (++n === 1 ? 'sorry, I cannot' : reply('B lost on a fade.')))
    const stat = await annotatePostMortems(rows, llm)

    expect(llm).toHaveBeenCalledTimes(2)
    expect(stat).toMatchObject({ asked: 2, written: 1 })
    expect(rows[0].postMortem.via).toBe('failed')
    expect(rows[0].postMortem.sentence).toBeUndefined()
    expect(rows[1].postMortem.sentence).toBe('B lost on a fade.')
  })

  it('no rows, no calls', async () => {
    const llm = vi.fn(async () => reply('never'))
    expect(await annotatePostMortems([], llm)).toMatchObject({ asked: 0, written: 0, overflow: 0 })
    expect(llm).not.toHaveBeenCalled()
  })
})
