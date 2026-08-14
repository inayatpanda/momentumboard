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

export interface SliceState<T> {
  data: T | null
  fetchedAt: number | null
  refreshing: boolean
  offline: boolean
  refresh(): void
}

export function useSlice<T>(key: SliceKey, fetcher: () => Promise<T>): SliceState<T> {
  const [rec, setRec] = useState<{ data: T | null; fetchedAt: number | null }>({ data: null, fetchedAt: null })
  const [refreshing, setRefreshing] = useState(false)
  const [offline, setOffline] = useState(false)
  const alive = useRef(true)
  // THE GENERATION GUARD (Task 15's find): `alive` alone is a single
  // re-armable ref, so a load() continuation from the OLD key could setState
  // after an in-place key change re-armed it. Every key change bumps the
  // generation (in the effect cleanup, which runs before the new effect);
  // a continuation only writes state if its captured generation is current.
  const gen = useRef(0)
  // The fetcher is almost always an inline closure — ref it so a re-render
  // never re-triggers the effect.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const load = useCallback(
    async (force: boolean) => {
      const myGen = gen.current
      const live = () => alive.current && gen.current === myGen
      const cached = await readSlice<T>(key)
      if (cached && live()) setRec({ data: cached.data, fetchedAt: cached.fetchedAt })
      if (!force && isFresh(cached, key)) return
      if (!live()) return
      setRefreshing(true)
      try {
        await revalidate(key, () => fetcherRef.current(), { force })
        const fresh = await readSlice<T>(key)
        if (live() && fresh) {
          setRec({ data: fresh.data, fetchedAt: fresh.fetchedAt })
          setOffline(false)
        }
      } catch {
        // Refresh failed. The cached paint (if any) stays on screen — that IS
        // the local-first contract; the pill says how old it is.
        if (live()) setOffline(true)
      } finally {
        if (live()) setRefreshing(false)
      }
    },
    [key],
  )

  useEffect(() => {
    alive.current = true
    void load(false)
    const onSlice = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; kind: SliceEventKind }>).detail
      if (d.key !== key) return
      if (d.kind === 'invalidate') void load(true)
      else
        void readSlice<T>(key).then(r => {
          if (alive.current && r) setRec({ data: r.data, fetchedAt: r.fetchedAt })
        })
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
  useEffect(() => {
    reportSliceHealth(key, { offline, fetchedAt: rec.fetchedAt })
  }, [key, offline, rec.fetchedAt])
  useEffect(() => () => reportSliceHealth(key, null), [key])

  return { data: rec.data, fetchedAt: rec.fetchedAt, refreshing, offline, refresh: () => void load(true) }
}
