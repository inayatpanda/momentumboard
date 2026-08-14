// apiViews (plan Task 9): the typed getters over the Phase-1 view slices.
// Token handling stays in api.ts's apiGet — one place — so these tests assert
// URL shape, sym normalisation and envelope unwrapping only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBoardSlice, getFunnel, getJourney, getLearning, getLedgerDays, getVerdict } from './apiViews'

const calls: string[] = []

beforeEach(() => {
  localStorage.setItem('mb-token', 'tok-1')
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url))
      expect(new Headers(init?.headers).get('x-app-token')).toBe('tok-1')
      return new Response(JSON.stringify({ ok: true, data: { marker: String(url) } }), { status: 200 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('apiViews', () => {
  it('hits each view with the right query and unwraps the envelope', async () => {
    const board = await getBoardSlice()
    expect(calls[0]).toBe('/api/engine?view=board')
    expect(board).toEqual({ marker: '/api/engine?view=board' })

    await getJourney('nvda')
    expect(calls[1]).toBe('/api/engine?view=journey&sym=NVDA')
    await getJourney('NVDA', 250)
    expect(calls[2]).toBe('/api/engine?view=journey&sym=NVDA&days=250')

    await getFunnel()
    expect(calls[3]).toBe('/api/engine?view=funnel')
    await getFunnel('2026-08-13')
    expect(calls[4]).toBe('/api/engine?view=funnel&date=2026-08-13')

    await getLedgerDays(30)
    expect(calls[5]).toBe('/api/engine?view=ledger&days=30')

    await getLearning()
    expect(calls[6]).toBe('/api/engine?view=learning')

    await getVerdict('zap')
    expect(calls[7]).toBe('/api/engine?view=verdict&sym=ZAP')
  })
})
