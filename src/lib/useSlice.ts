// useSlice (plan Task 8 + CX-4): the one way a v2 screen gets data.
//
// Paint what Dexie has IMMEDIATELY, revalidate in the background when stale,
// patch the screen when fresh bytes land, and flip `offline` when a refresh
// fails while cache exists — the screen keeps its data either way. Refresh
// triggers: mount, visibility/focus, an 'invalidate' announcement, or the
// returned refresh() (pull-to-refresh). Never a poll.

import { useCallback, useEffect, useRef, useState } from 'react'
import { isFresh, readSlice, revalidate, sliceEvents, type SliceEventKind, type SliceKey } from './store'
import { reportSliceHealth } from '../shell/OfflinePill'

/** Mints the per-hook id the offline registry is keyed on (D1). Module-level
 * and monotonic — an id must be unique across every hook alive at once, which a
 * key-derived one is not. */
let hookSeq = 0

export interface SliceState<T> {
  data: T | null
  fetchedAt: number | null
  refreshing: boolean
  offline: boolean
  /** A failed request is an answer, not an indefinitely loading slice. */
  error: string | null
  refresh(): void
}

export function useSlice<T>(key: SliceKey, fetcher: () => Promise<T>): SliceState<T> {
  type State = Omit<SliceState<T>, 'refresh'> & { key: SliceKey }
  const empty = (): State => ({ key, data: null, fetchedAt: null, refreshing: false, offline: false, error: null })
  const [state, setState] = useState<State>(empty)
  // Never display another ticker/range's cache while its replacement loads.
  // Keying the visible state also covers the render before effect cleanup.
  const current = state.key === key ? state : empty()
  const alive = useRef(true)
  // THE GENERATION GUARD (Task 15's find): `alive` alone is a single
  // re-armable ref, so a load() continuation from the OLD key could setState
  // after an in-place key change re-armed it. Every key change bumps the
  // generation (in the effect cleanup, which runs before the new effect);
  // a continuation only writes state if its captured generation is current.
  const gen = useRef(0)
  const request = useRef(0)
  // The fetcher is almost always an inline closure — ref it so a re-render
  // never re-triggers the effect.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const load = useCallback(
    async (force: boolean) => {
      const myGen = gen.current
      const myRequest = ++request.current
      const live = () => alive.current && gen.current === myGen && request.current === myRequest
      const update = (patch: Partial<State>) => {
        if (live()) setState(previous => ({ ...(previous.key === key ? previous : empty()), ...patch }))
      }
      // THE FETCHER IS PINNED TO THE KEY, at entry (final wave, found by B1's
      // one-record test). `revalidate` awaits its own cache read before it
      // invokes the fetcher, so reading `fetcherRef.current` down there read
      // whatever the LATEST render had installed — which, after an in-place key
      // change, is the NEW key's closure. StockPage's range pills made that
      // concrete: click 3mo while the 6mo load is between its two awaits and
      // the 3mo payload was fetched and written under `candles:SYM:6mo`, wrong
      // bytes under a live key for the full TTL. The generation guard could not
      // catch it — it only gates setState, and this corruption is a WRITE.
      const fetcher = fetcherRef.current
      update({ error: null, refreshing: true })
      try {
        const cached = await readSlice<T>(key)
        if (cached) update({ data: cached.data, fetchedAt: cached.fetchedAt })
        if (!force && isFresh(cached, key)) return
        if (!live()) return
        await revalidate(key, fetcher, { force })
        const fresh = await readSlice<T>(key)
        if (live() && fresh) {
          update({ data: fresh.data, fetchedAt: fresh.fetchedAt, offline: false, error: null })
        }
      } catch (e) {
        // Refresh failed. The cached paint (if any) stays on screen — that IS
        // the local-first contract. The pill is a CONNECTIVITY claim (A2): a
        // fetch network failure rejects with TypeError, and a hidden tab's
        // radio being off shows as navigator.onLine=false — an HTTP error
        // (`http-404`, an api envelope error) is a server ANSWER and must not
        // be dressed as "offline".
        const isNetwork = e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false)
        update({
          offline: isNetwork,
          error: isNetwork ? 'Connection unavailable. Check your connection and try again.' : e instanceof Error ? e.message : 'The request failed. Please try again.',
        })
      } finally {
        update({ refreshing: false })
      }
    },
    [key],
  )

  useEffect(() => {
    alive.current = true
    const myGen = gen.current
    void load(false)
    const onSlice = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; kind: SliceEventKind }>).detail
      if (d.key !== key) return
      if (d.kind === 'invalidate') void load(true)
      else
        void readSlice<T>(key).then(r => {
          if (alive.current && gen.current === myGen && r) {
            setState(previous => ({ ...(previous.key === key ? previous : empty()), data: r.data, fetchedAt: r.fetchedAt, error: null, offline: false }))
          }
        }).catch(() => {}) // load() reports cache/network failures through error
    }
    const onWake = () => {
      if (document.visibilityState === 'visible') void load(false)
    }
    sliceEvents.addEventListener('slice', onSlice)
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      alive.current = false
      gen.current++ // orphan every in-flight continuation for the old key
      sliceEvents.removeEventListener('slice', onSlice)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [key, load])

  // The app-wide offline pill (DS-13): every mounted slice reports its health;
  // the pill shows when any is offline, stamped with the oldest data age.
  //
  // Reported under THIS HOOK'S id, not the slice key (D1). Two components can
  // read one key at once — the desk mounts Today and the BoardColumn, both on
  // 'board' — and a key-keyed registry gave them a single shared row that either
  // unmount deleted, silencing the survivor's offline state. The id is minted
  // once per hook instance and never changes, including across a key change:
  // one mounted reader is one row, and it is replaced, not duplicated.
  const instanceId = useRef<string>('')
  if (!instanceId.current) instanceId.current = `slice-${++hookSeq}`
  useEffect(() => {
    reportSliceHealth(instanceId.current, { key, offline: current.offline, fetchedAt: current.fetchedAt })
  }, [key, current.offline, current.fetchedAt])
  // unmount ONLY (no deps): the row belongs to the instance, not to the key.
  useEffect(() => {
    const id = instanceId.current
    return () => reportSliceHealth(id, null)
  }, [])

  return { data: current.data, fetchedAt: current.fetchedAt, refreshing: current.refreshing, offline: current.offline, error: current.error, refresh: () => void load(true) }
}
