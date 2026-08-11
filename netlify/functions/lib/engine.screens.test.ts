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
})
