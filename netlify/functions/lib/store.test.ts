import { describe, expect, it } from 'vitest'
import { acquireLease, memoryStore, releaseLease, isTransientNetworkError, withBlobRetry } from './store'

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

// 2026-07-26 01:11: a single 10s connect timeout to the Blobs API took down the
// queue-worker run and emailed "all jobs have failed". The same blip during the
// morning run would have cost that day's paper.
describe('transient blob failures', () => {
  const timeout = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })

  it('recognises a connect timeout buried under undici\'s bland "fetch failed"', () => {
    expect(isTransientNetworkError(timeout())).toBe(true)
    expect(isTransientNetworkError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('does NOT retry a real error — a bad token must fail immediately', () => {
    expect(isTransientNetworkError(new Error('401 unauthorized'))).toBe(false)
    expect(isTransientNetworkError(new Error('invalid key'))).toBe(false)
  })

  it('retries through a blip and returns the value', async () => {
    let calls = 0
    const v = await withBlobRetry(async () => {
      if (++calls < 3) throw timeout()
      return 'ok'
    }, 'read x', async () => {})
    expect(v).toBe('ok')
    expect(calls).toBe(3)
  })

  it('gives up after the retries are spent, so a real outage still fails loudly', async () => {
    let calls = 0
    await expect(withBlobRetry(async () => { calls++; throw timeout() }, 'read x', async () => {})).rejects.toThrow('fetch failed')
    expect(calls).toBe(3) // initial + 2 retries
  })

  it('never retries a non-network error', async () => {
    let calls = 0
    await expect(withBlobRetry(async () => { calls++; throw new Error('401 unauthorized') }, 'read x', async () => {})).rejects.toThrow('401')
    expect(calls).toBe(1)
  })
})
