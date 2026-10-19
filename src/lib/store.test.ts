// The v2 slice store (plan Task 8, amendments DS-1/4/10/12/19/22 + CX-4/5):
// Dexie-backed SWR primitives. readSlice/writeSlice/revalidate are SEPARATE
// operations (a Promise can't resolve twice — CX-4); invalidateSlices is the
// one notification channel; polls do not exist.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { SLICE_TTL, gcSlices, invalidateSlices, readSlice, revalidate, sliceEvents, ttlFor, writeSlice } from './store'

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear()])
})
afterEach(() => vi.restoreAllMocks())

describe('slice store', () => {
  it('write→read roundtrips with a fetchedAt stamp, routing candles:/quotes: keys to their own tables', async () => {
    await writeSlice('board', { rows: 1 })
    const rec = await readSlice<{ rows: number }>('board')
    expect(rec?.data.rows).toBe(1)
    expect(rec?.fetchedAt).toBeGreaterThan(0)
    expect(await db.slices.get('board')).toBeTruthy()

    await writeSlice('candles:NVDA:1y', [{ c: 1 }])
    expect(await db.candles.get('candles:NVDA:1y')).toBeTruthy()
    expect(await db.slices.get('candles:NVDA:1y')).toBeUndefined()

    await writeSlice('quotes:NVDA', { px: 128 })
    expect(await db.quotes.get('quotes:NVDA')).toBeTruthy()
  })

  it('revalidate dedupes concurrent fetches for one key', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      await new Promise(r => setTimeout(r, 20))
      return { n: calls }
    }
    const [a, b] = await Promise.all([revalidate('board', fetcher), revalidate('board', fetcher)])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  it('revalidate short-circuits on a fresh cache unless forced', async () => {
    await writeSlice('board', { fresh: true })
    let calls = 0
    await revalidate('board', async () => {
      calls++
      return { fresh: false }
    })
    expect(calls).toBe(0)
    await revalidate('board', async () => {
      calls++
      return { fresh: false }
    }, { force: true })
    expect(calls).toBe(1)
  })

  it('a late superseded fetch cannot overwrite a completed forced refresh', async () => {
    let finishOld!: (v: string) => void
    const oldFetcher = vi.fn(() => new Promise<string>(resolve => { finishOld = resolve }))
    const old = revalidate('board:late', oldFetcher)
    await vi.waitFor(() => expect(oldFetcher).toHaveBeenCalledOnce())
    await revalidate('board:late', async () => 'new', { force: true })
    finishOld('old')
    await old
    expect((await readSlice('board:late'))?.data).toBe('new')
  })

  it('registers ownership before an old cache lookup can yield to a forced refresh', async () => {
    let releaseRead!: () => void
    const readStarted = new Promise<void>(resolve => { releaseRead = resolve })
    const get = db.slices.get.bind(db.slices)
    vi.spyOn(db.slices, 'get').mockImplementationOnce(() => Dexie.Promise.resolve(readStarted).then(() => undefined))
    const old = revalidate('board:cache-race', async () => 'old')
    await Promise.resolve()
    await revalidate('board:cache-race', async () => 'new', { force: true })
    releaseRead()
    await old
    expect((await get('board:cache-race'))?.data).toBe('new')
  })

  it('a replaced request settling does not release the newer in-flight request', async () => {
    let finishOld!: (v: string) => void
    let finishNew!: (v: string) => void
    const first = vi.fn(() => new Promise<string>(r => { finishOld = r }))
    const second = vi.fn(() => new Promise<string>(r => { finishNew = r }))
    const old = revalidate('board:race', first)
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
    const fresh = revalidate('board:race', second, { force: true })
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
    finishOld('old')
    await old
    const unnecessary = vi.fn(async () => 'third')
    const joined = revalidate('board:race', unnecessary)
    finishNew('new')
    expect(await fresh).toBe('new')
    expect(await joined).toBe('new')
    expect(unnecessary).not.toHaveBeenCalled()
  })

  it('ttlFor knows the per-slice windows: journey 2 min, board/quotes 2 min, ledger 15 min, default 15 min', () => {
    expect(ttlFor('journey:NVDA')).toBe(120_000)
    expect(ttlFor('board')).toBe(SLICE_TTL.board)
    expect(ttlFor('ledger:7')).toBe(900_000)
    expect(ttlFor('something-unknown')).toBe(SLICE_TTL.default)
  })

  // The chart's short ranges: a 1D chart 15 minutes stale has missed three
  // whole bars, so the freshness window follows the range the same way the
  // server's cache does (netlify/functions/lib/yahoo.ts, CANDLE_RANGES).
  it('ttlFor tightens for intraday candle ranges and leaves the daily ones at 15 min', () => {
    expect(ttlFor('candles:NVDA:1d')).toBe(300_000)
    expect(ttlFor('candles:BTC-USD:5d')).toBe(600_000)
    expect(ttlFor('candles:NVDA:1mo')).toBe(900_000)
    expect(ttlFor('candles:NVDA:3mo')).toBe(SLICE_TTL.candles)
    expect(ttlFor('candles:NVDA:1y')).toBe(SLICE_TTL.candles)
  })

  it('writeSlice and invalidateSlices both announce, distinguishably — writes re-render, invalidations refetch', async () => {
    const seen: { key: string; kind: string }[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent<{ key: string; kind: string }>).detail)
    sliceEvents.addEventListener('slice', listener)
    try {
      await writeSlice('board', { x: 1 })
      invalidateSlices(['learning', 'board'])
      expect(seen).toEqual([
        { key: 'board', kind: 'write' },
        { key: 'learning', kind: 'invalidate' },
        { key: 'board', kind: 'invalidate' },
      ])
    } finally {
      sliceEvents.removeEventListener('slice', listener)
    }
  })

  it('gcSlices sweeps records older than 7 days, all three tables', async () => {
    const old = Date.now() - 8 * 86_400_000
    await db.slices.put({ key: 'ancient', data: {}, fetchedAt: old })
    await db.candles.put({ key: 'candles:OLD:1y', data: [], fetchedAt: old })
    await writeSlice('board', { keep: true })
    await gcSlices()
    expect(await db.slices.get('ancient')).toBeUndefined()
    expect(await db.candles.get('candles:OLD:1y')).toBeUndefined()
    expect(await db.slices.get('board')).toBeTruthy()
  })

  it('the data layer never polls — no setInterval in the v2 client source', () => {
    for (const f of ['src/lib/store.ts', 'src/lib/useSlice.ts']) {
      expect(readFileSync(resolve(process.cwd(), f), 'utf8'), f).not.toContain('setInterval')
    }
  })
})
