// AskSheet (plan Task 18) — "Ask the desk" on the journey page. The engine's
// verdict is authoritative; the LLM only narrates it. Every request (first
// question AND every follow-up) must carry the SAME compact context block
// built from what the page already has in hand — this file's core job is
// proving that never slips, plus the ordinary sheet mechanics (open/close,
// the daily cap, one request in flight at a time).

import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskSheet, ASK_DAILY_CAP, buildAskContext } from './parts/AskSheet'
import type { EnginePrediction } from '../lib/api'
import type { JourneyFunnelRow, VerdictRead } from '../lib/apiViews'

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () => Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

function mkRow(overrides: Partial<EnginePrediction> = {}): EnginePrediction {
  return {
    id: 'r1',
    sym: 'NVDA',
    name: 'NVIDIA',
    side: 'long',
    composite: 62,
    probability: 0.62,
    provisional: false,
    grade: 'A',
    expectedMovePct: 4.3,
    entry: 128.4,
    stop: 121.1,
    target: 141,
    capacityPct: 100,
    smallCap: false,
    earningsRisk: false,
    stage: 'trending',
    note: 'test note',
    riskRung: 3,
    riskPct: 1.25,
    instrument: null,
    paperOnly: false,
    factors: emptyFactors(),
    ...overrides,
  }
}

const dayKey = () => new Date().toISOString().slice(0, 10)
const askCountKey = () => `mb-ask-count:${dayKey()}`

const jsonResponse = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as Response)

/** A thin stateful wrapper — AskSheet is a controlled component, so a real
 * open→close round trip needs somewhere to hold `open`. */
function Harness(props: Partial<React.ComponentProps<typeof AskSheet>> & { onCloseSpy?: () => void }) {
  const [open, setOpen] = useState(props.open ?? true)
  return (
    <AskSheet
      sym="NVDA"
      row={mkRow()}
      {...props}
      open={open}
      onClose={() => {
        setOpen(false)
        props.onCloseSpy?.()
      }}
    />
  )
}

const contextFromUrl = (url: string): { sym: string; state: string; grade: string | null } => {
  const raw = new URL(url, 'http://x').searchParams.get('context')
  return JSON.parse(raw ?? '{}')
}

describe('AskSheet', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    fetchMock = vi.fn(() => jsonResponse({ answer: 'A grounded answer.', at: 1 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('open / close', () => {
    it('renders nothing while closed', () => {
      render(<Harness open={false} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('opens as a labelled dialog and closes on Escape', async () => {
      const onCloseSpy = vi.fn()
      render(<Harness onCloseSpy={onCloseSpy} />)
      expect(await screen.findByRole('dialog', { name: /ask the desk about nvda/i })).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onCloseSpy).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('closes on a scrim click', async () => {
      const onCloseSpy = vi.fn()
      render(<Harness onCloseSpy={onCloseSpy} />)
      await screen.findByRole('dialog')
      fireEvent.click(document.querySelector('.ask-scrim')!)
      expect(onCloseSpy).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })
  })

  describe('every request carries the context block', () => {
    it('the first question sends a context JSON built from the hero state', async () => {
      render(<Harness row={mkRow({ grade: 'A', side: 'long', composite: 62 })} />)
      const input = await screen.findByLabelText(/ask a question about nvda/i)
      fireEvent.change(input, { target: { value: 'Good entry here?' } })
      fireEvent.click(screen.getByRole('button', { name: /^ask$/i }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('context=')
      const ctx = contextFromUrl(url)
      expect(ctx.sym).toBe('NVDA')
      expect(ctx.state).toBe('sized')
      expect(ctx.grade).toBe('A')
      await screen.findByText('A grounded answer.')
    })

    it('a follow-up question re-sends the SAME context — no context-free turn', async () => {
      render(<Harness row={mkRow({ grade: 'B' })} />)
      const input = await screen.findByLabelText(/ask a question about nvda/i)
      fireEvent.change(input, { target: { value: 'Good entry here?' } })
      fireEvent.click(screen.getByRole('button', { name: /^ask$/i }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await screen.findByText('A grounded answer.')

      fireEvent.change(input, { target: { value: 'Where would a stop go?' } })
      fireEvent.click(screen.getByRole('button', { name: /^ask$/i }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

      const first = contextFromUrl(fetchMock.mock.calls[0][0] as string)
      const second = contextFromUrl(fetchMock.mock.calls[1][0] as string)
      expect(second).toEqual(first)
      expect(second.state).toBe('sized')
      expect(second.grade).toBe('B')
    })
  })

  describe('non-admin soft cap (20/day)', () => {
    it('at the cap: the friendly line shows and no request is sent', async () => {
      localStorage.setItem(askCountKey(), String(ASK_DAILY_CAP))
      render(<Harness />)
      expect(await screen.findByText(/the desk is out of answers for today/i)).toBeInTheDocument()
      expect(screen.queryByLabelText(/ask a question about nvda/i)).not.toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('below the cap: the ask form is offered normally', async () => {
      localStorage.setItem(askCountKey(), String(ASK_DAILY_CAP - 1))
      render(<Harness />)
      expect(await screen.findByLabelText(/ask a question about nvda/i)).toBeInTheDocument()
      expect(screen.queryByText(/out of answers for today/i)).not.toBeInTheDocument()
    })
  })

  describe('one request in flight at a time', () => {
    it('the ask control is disabled while a request is pending, and re-enabled after', async () => {
      let resolvePending: (v: Response) => void = () => {}
      fetchMock.mockImplementation(() => new Promise<Response>(res => { resolvePending = res }))
      render(<Harness />)
      const input = await screen.findByLabelText(/ask a question about nvda/i)
      fireEvent.change(input, { target: { value: 'Good entry here?' } })
      fireEvent.click(screen.getByRole('button', { name: /^ask$/i }))
      await waitFor(() => expect(input).toBeDisabled())
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // a second submit attempt while pending must not fire a second request
      fireEvent.click(screen.getByRole('button', { name: /…/ }))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      resolvePending({ ok: true, json: async () => ({ ok: true, data: { answer: 'done', at: 1 } }) } as Response)
      await waitFor(() => expect(input).not.toBeDisabled())
    })
  })
})

// buildAskContext — the compact hero-state summary pinned server-side (CX-20).
// Mirrors VerdictHero's own six-way branch so the sheet can never ground an
// answer in a state the reader isn't looking at.
describe('buildAskContext', () => {
  it('a sized, live row: state sized, carries the grade', () => {
    const ctx = buildAskContext({ sym: 'NVDA', row: mkRow({ grade: 'A', side: 'long', composite: 62 }) })
    expect(ctx).toMatchObject({ sym: 'NVDA', state: 'sized', grade: 'A', side: 'long', core: 62 })
  })

  it('an unsized (watch) row: no grade at all', () => {
    const ctx = buildAskContext({ sym: 'NVDA', row: mkRow({ watchOnly: true, grade: 'B' }) })
    expect(ctx.state).toBe('unsized')
    expect(ctx.grade).toBeNull()
  })

  it('a refusal: the gate label, the bare core, never a grade', () => {
    const refusalRow: JourneyFunnelRow = { key: 'NVDA:long', gate: 'entry-chase', side: 'long', core: 58.4 }
    const ctx = buildAskContext({ sym: 'NVDA', refusal: { date: '2026-08-14', row: refusalRow } })
    expect(ctx.state).toBe('refused')
    expect(ctx.grade).toBeNull()
    expect(ctx.core).toBe(58.4)
    expect(ctx.gateLabel).toMatch(/chase/)
  })

  it('an on-demand read: the lean, the core, no grade', () => {
    const verdict: VerdictRead = {
      sym: 'TSLA', onDemand: true, at: '2026-08-14T09:00:00Z', lean: 'long', core: 41.2, stage: 'basing',
      computed: [], nulls: [], lastClose: 214.5, atr: 6.2, note: 'on-demand note',
    }
    const ctx = buildAskContext({ sym: 'TSLA', verdict })
    expect(ctx.state).toBe('on-demand')
    expect(ctx.side).toBe('long')
    expect(ctx.core).toBe(41.2)
    expect(ctx.grade).toBeNull()
  })

  it('a live open call: the open-trace verdict rides along', () => {
    const ctx = buildAskContext({ sym: 'NVDA', row: mkRow(), openTrace: { verdict: 'still-on', status: 'in-play' } as never })
    expect(ctx.openTrace).toEqual({ status: 'in-play', verdict: 'still-on' })
  })

  it('nothing at all: no-read, every field null', () => {
    const ctx = buildAskContext({ sym: 'NVDA' })
    expect(ctx.state).toBe('no-read')
    expect(ctx.grade).toBeNull()
    expect(ctx.core).toBeNull()
  })
})
