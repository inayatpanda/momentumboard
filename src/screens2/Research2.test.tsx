// Research2 (visibility wave, 2026-08-17). Same local-first pattern as the
// other screens2 suites: every fetcher is mocked to NEVER resolve, each case
// seeds the Dexie slice directly and asserts on the cached paint.
//
// Three findings from the live desk walkthrough are pinned here:
//   the event assessments arrived as one paragraph of literal `**asterisks**`
//   the AI-read card printed the SERVER's own "AI gateway not configured"
//   the AI summary carried an `at` nothing rendered

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import Research2, { AI_READ_UNAVAILABLE, aiReadCopy } from './Research2'
import { inlineParts, splitBlocks } from './parts/MarkdownLite'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const never = () => new Promise<never>(() => {})
  return { ...actual, getAiRead: never, getEventDossiers: never, getPicks: never, getPickStats: never, getOutcomes: never }
})

const withRouter = () => render(<Router base="/app" hook={memoryLocation({ path: '/app/research' }).hook}>{<Research2 />}</Router>)

const seed = (key: string, data: unknown) => db.slices.put({ key, data, fetchedAt: Date.now() })

const mkEvent = (assessment: string) => ({
  kind: 'shock' as const,
  sym: 'CL=F',
  name: 'WTI Crude Oil',
  movePct: 5.1,
  dir: 'up',
  price: 82.95,
  assessment,
  at: 1_755_000_000,
})

beforeEach(async () => {
  await db.slices.clear()
})

describe('MarkdownLite — the deterministic renderer', () => {
  describe('splitBlocks', () => {
    it('splits a collapsed numbered list into one block per step', () => {
      const blocks = splitBlocks('1. **Event Analysis**: WTI rose 5.1%. 2. **Magnitude Guess**: a further 0.4% move.')
      expect(blocks.map(b => b.kind)).toEqual(['number', 'number'])
      expect(blocks.map(b => b.marker)).toEqual(['1.', '2.'])
      expect(blocks[0].text).toContain('Event Analysis')
      expect(blocks[1].text).toContain('Magnitude Guess')
    })

    it('splits dashed bullets out of the step that carries them', () => {
      const blocks = splitBlocks('2. **Magnitude**: - **Base Case**: 0.4%. - **Stretch Case**: 8.3%.')
      expect(blocks.map(b => b.kind)).toEqual(['number', 'bullet', 'bullet'])
      expect(blocks[1].text).toContain('Base Case')
      expect(blocks[2].text).toContain('Stretch Case')
    })

    it('never mistakes a year, a decimal or a percentage for a step marker', () => {
      const blocks = splitBlocks('Prices ran to $82.95 by 2026. Traders saw an 8.8% move and a 33%. extension.')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].kind).toBe('para')
      expect(blocks[0].text).toContain('2026. Traders')
    })

    it('breaks on real newlines too, and drops the blank ones', () => {
      expect(splitBlocks('first line\n\nsecond line').map(b => b.text)).toEqual(['first line', 'second line'])
    })

    it('an empty or whitespace-only assessment yields no blocks at all', () => {
      expect(splitBlocks('')).toEqual([])
      expect(splitBlocks('   \n  ')).toEqual([])
    })
  })

  describe('inlineParts', () => {
    it('marks **bold** runs and leaves the surrounding prose alone', () => {
      expect(inlineParts('a **bold** c')).toEqual([
        { bold: false, text: 'a ' },
        { bold: true, text: 'bold' },
        { bold: false, text: ' c' },
      ])
    })

    it('leaves an unpaired ** literal rather than swallowing the rest', () => {
      expect(inlineParts('a **dangling')).toEqual([{ bold: false, text: 'a **dangling' }])
    })
  })

  it('renders bold as <strong> and escapes anything that looks like HTML', async () => {
    await seed('research:events', [mkEvent('1. **Head**: <img src=x onerror=alert(1)> tail.')])
    withRouter()
    const events = await screen.findByLabelText('Event assessments')
    expect((await within(events).findByText('Head')).tagName).toBe('STRONG')
    // the tag arrived as TEXT, never as an element
    expect(events.querySelector('img')).toBeNull()
    expect(events.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders one line per numbered step instead of one collapsed paragraph', async () => {
    await seed('research:events', [mkEvent('1. **Event Analysis**: crude rose. 2. **Magnitude**: a further 0.4% move. 3. **Playbook**: XOM, CVX.')])
    withRouter()
    const events = await screen.findByLabelText('Event assessments')
    await within(events).findByText('Playbook')
    expect(events.querySelectorAll('.md-lite-line')).toHaveLength(3)
    // and no literal asterisk survives to the screen
    expect(events.textContent).not.toContain('**')
  })
})

describe('Research2 — the AI summary card', () => {
  describe('aiReadCopy', () => {
    it('a real read is passed through and marked as a read', () => {
      expect(aiReadCopy({ text: 'The tape is thin.' })).toEqual({ body: 'The tape is thin.', isRead: true })
    })

    it("the server's unconfigured flag becomes honest reader copy", () => {
      expect(aiReadCopy({ unconfigured: true })).toEqual({ body: AI_READ_UNAVAILABLE, isRead: false })
    })

    it('the server sentence arriving as `text` is mapped too, never printed', () => {
      expect(aiReadCopy({ text: 'AI gateway not configured on this site.' })).toEqual({ body: AI_READ_UNAVAILABLE, isRead: false })
    })

    it('an absent read of any other shape lands on the same honest line', () => {
      expect(aiReadCopy({})).toEqual({ body: AI_READ_UNAVAILABLE, isRead: false })
      expect(aiReadCopy({ text: '   ' })).toEqual({ body: AI_READ_UNAVAILABLE, isRead: false })
    })

    it('an empty watchlist keeps its own actionable line — a different cause', () => {
      expect(aiReadCopy({ empty: true }).body).toMatch(/watchlist/i)
    })
  })

  it('never renders the raw server string on screen', async () => {
    await seed('research:aiRead', { unconfigured: true })
    withRouter()
    const card = await screen.findByLabelText('AI summary')
    expect(await within(card).findByText(AI_READ_UNAVAILABLE)).toBeInTheDocument()
    expect(card.textContent).not.toContain('AI gateway not configured')
  })

  it('stamps a real read with when the desk wrote it', async () => {
    await seed('research:aiRead', { text: 'The tape is thin.', provider: 'groq', at: Math.floor(Date.now() / 1000) - 7200 })
    withRouter()
    const card = await screen.findByLabelText('AI summary')
    expect(await within(card).findByText(/AI summary · 2h ago/)).toBeInTheDocument()
  })

  it('carries no stamp when there is no read to date', async () => {
    await seed('research:aiRead', { unconfigured: true, at: Math.floor(Date.now() / 1000) - 7200 })
    withRouter()
    const card = await screen.findByLabelText('AI summary')
    await within(card).findByText(AI_READ_UNAVAILABLE)
    expect(within(card).getByText('AI summary')).toBeInTheDocument()
  })
})
