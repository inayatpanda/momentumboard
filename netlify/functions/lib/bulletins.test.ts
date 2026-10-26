import { describe, expect, it } from 'vitest'
import { bulletinBoardLine, bulletinBoardRowHtml, type BulletinBoardMark } from './bulletins'

// THE TWO DISPATCHES THE READER IS SENT BETWEEN PAPERS. Both print the board
// marked to market, and until the final review of Stage 3d both printed the
// EXPERIMENT exactly like a conviction call: same line, same grade, same
// mark-to-market percentage. A wildcard is a quarter-size row on a trade the
// engine's own gates refused; a reader meeting it in a Telegram push with no mark
// is being shown the engine's least-believed row as one of its calls.

const mark = (over: Partial<BulletinBoardMark> = {}): BulletinBoardMark => ({
  sym: 'SOFI',
  side: 'long',
  grade: 'B',
  entry: 14.8,
  now: 15.4,
  stop: 13.9,
  target: 17.2,
  movePct: 4.1,
  ...over,
})

describe('the bulletin board line — Telegram', () => {
  it('an ordinary call is worded exactly as it always was', () => {
    expect(bulletinBoardLine(mark())).toBe('SOFI LONG B · in 14.8 → 15.4 (+4.1%) · stop 13.9 · tgt 17.2')
    expect(bulletinBoardLine(mark())).not.toContain('Experimental:')
  })

  it('a wildcard row wears the mark', () => {
    const line = bulletinBoardLine(mark({ wildcard: true }))
    expect(line).toBe('Experimental: SOFI LONG B · in 14.8 → 15.4 (+4.1%) · stop 13.9 · tgt 17.2')
  })

  it('the mark is the ONLY difference — every number and both optional halves survive', () => {
    const bare = mark({ now: null, movePct: null })
    expect(bulletinBoardLine(bare)).toBe('SOFI LONG B · in 14.8 · stop 13.9 · tgt 17.2')
    expect(bulletinBoardLine({ ...bare, wildcard: true })).toBe(`Experimental: ${bulletinBoardLine(bare)}`)
    expect(bulletinBoardLine({ ...mark(), wildcard: true })).toBe(`Experimental: ${bulletinBoardLine(mark())}`)
  })
})

describe('the bulletin board row — email', () => {
  it('an ordinary call carries no mark and keeps its two stacked lines', () => {
    const html = bulletinBoardRowHtml(mark())
    expect(html).not.toContain('Experimental:')
    expect(html).toContain('<b>SOFI</b>')
    expect(html).toContain('in 14.8 → 15.4 · stop 13.9 · tgt 17.2')
    expect(html).toContain('+4.1%')
  })

  it('a wildcard row wears the mark beside the ticker', () => {
    const html = bulletinBoardRowHtml(mark({ wildcard: true }))
    expect(html).toContain('Experimental: <b>SOFI</b>')
    // …and nothing else about the row moved
    expect(html.replace('Experimental: ', '')).toBe(bulletinBoardRowHtml(mark()))
  })

  it('escapes the ticker like the rest of the mini-edition', () => {
    expect(bulletinBoardRowHtml(mark({ sym: 'A&B<C' }))).toContain('A&amp;B&lt;C')
  })
})
