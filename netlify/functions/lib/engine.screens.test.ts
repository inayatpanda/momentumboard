import { describe, expect, it, vi } from 'vitest'

vi.mock('./screener', () => ({
  fetchScreen: vi.fn(async () => []),
  fetchTrending: vi.fn(async () => []),
}))

import { fetchScreen } from './screener'
import { defaultDeps } from './engine'

describe('screens dep', () => {
  it('requests day_losers alongside the three existing screens', async () => {
    await defaultDeps({}).screens()
    const kinds = (fetchScreen as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(kinds).toContain('day_losers')
    expect(kinds).toHaveLength(4)
  })
  it('digs 50 deep for gainers only — the other three stay 25', async () => {
    ;(fetchScreen as ReturnType<typeof vi.fn>).mockClear()
    await defaultDeps({}).screens()
    const depth = new Map((fetchScreen as ReturnType<typeof vi.fn>).mock.calls.map(c => [c[0], c[2]]))
    expect(depth.get('day_gainers')).toBe(50)
    expect(depth.get('day_losers')).toBe(25)
    expect(depth.get('most_actives')).toBe(25)
    expect(depth.get('small_cap_gainers')).toBe(25)
  })
})
