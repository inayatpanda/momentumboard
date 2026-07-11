import { describe, expect, it } from 'vitest'
import { acquireLease, memoryStore, releaseLease } from './store'

describe('store lease', () => {
  it('admits one owner, rejects overlap, releases, and expires safely', async () => {
    const store = memoryStore()
    const first = await acquireLease(store, 'lease:test', 100, 60)
    expect(first).toBeTruthy()
    expect(await acquireLease(store, 'lease:test', 120, 60)).toBeNull()

    await releaseLease(store, 'lease:test', 'not-the-owner')
    expect(await acquireLease(store, 'lease:test', 130, 60)).toBeNull()

    await releaseLease(store, 'lease:test', first!)
    expect(await acquireLease(store, 'lease:test', 131, 60)).toBeTruthy()
    expect(await acquireLease(store, 'lease:test', 500, 60)).toBeTruthy()
  })
})
