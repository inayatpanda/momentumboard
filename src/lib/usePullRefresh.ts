// PULL TO REFRESH, AND THE HAND THAT PULLS (dynamism wave, feature 3).
//
// `useSlice` has always returned `refresh()` and `refreshing`, and not one
// screen called either: the only way to force fresh bytes was to background
// the app and come back (the hook's visibility listener). So the app looked
// inert exactly when the reader most wanted it to move.
//
// Two hooks, no dependencies:
//
//   · usePullRefresh — the phone gesture. Touch events only, armed ONLY at
//     scroll top, cancelled the moment the page scrolls or a second finger
//     lands. Listeners are passive: we never call preventDefault, so the
//     browser's own overscroll bounce is untouched and scrolling never janks.
//
//   · useSlicesRefresh — the desk button's other half, and the pull's, for the
//     screens whose slices live inside their CHILDREN (Stocks' rails, Intel's
//     five sections). It force-revalidates the keys the screen names, through
//     the very same `revalidate` a slice's own refresh() calls; every mounted
//     `useSlice` on those keys repaints off the write announcement. It reports
//     a REAL busy flag — the settle of the actual fetches, never a timer.
//
// Neither polls. src/lib/store.ts and src/lib/useSlice.ts remain poll-free by
// their own test-enforced rule, and nothing here is on an interval.

import { useCallback, useEffect, useRef, useState } from 'react'
import { revalidate, type SliceKey } from './store'

/** Finger travel, in CSS px, that counts as "the reader meant it". */
export const PULL_THRESHOLD = 72
/** Past this the indicator stops growing — a long drag is still one refresh. */
const MAX_PULL = 120

export interface PullState {
  /** Current pull distance in px, 0 when no gesture is in flight. */
  pull: number
  /** Would letting go right now fire the refresh? */
  armed: boolean
}

export function usePullRefresh(
  onRefresh: () => void,
  opts?: {
    enabled?: boolean
    threshold?: number
    /** How far the page is scrolled. Injectable because jsdom's `scrollTop` is
     * a no-op, and because the desk panes scroll themselves rather than the
     * document — a caller there can hand in its own reader. */
    scrollTop?: () => number
  },
): PullState {
  const threshold = opts?.threshold ?? PULL_THRESHOLD
  const enabled = opts?.enabled ?? true
  const [pull, setPull] = useState(0)
  const pullRef = useRef(0)
  const startY = useRef<number | null>(null)
  // Ref'd so a screen passing an inline closure never re-arms the listeners.
  const cb = useRef(onRefresh)
  cb.current = onRefresh
  const scrollRead = useRef(opts?.scrollTop)
  scrollRead.current = opts?.scrollTop

  useEffect(() => {
    if (!enabled) return
    const scrollTop = () => scrollRead.current?.() ?? document.scrollingElement?.scrollTop ?? window.scrollY ?? 0
    const set = (v: number) => {
      pullRef.current = v
      setPull(v)
    }
    const cancel = () => {
      startY.current = null
      if (pullRef.current !== 0) set(0)
    }
    const onStart = (e: Event) => {
      const t = (e as TouchEvent).touches
      startY.current = t && t.length === 1 && scrollTop() <= 0 ? t[0].clientY : null
      if (pullRef.current !== 0) set(0)
    }
    const onMove = (e: Event) => {
      if (startY.current == null) return
      const t = (e as TouchEvent).touches
      // a second finger is a pinch, and any scroll at all means the reader is
      // reading, not pulling
      if (!t || t.length !== 1 || scrollTop() > 0) return cancel()
      const dy = t[0].clientY - startY.current
      set(dy <= 0 ? 0 : Math.min(MAX_PULL, dy))
    }
    const onEnd = () => {
      const fire = startY.current != null && pullRef.current >= threshold
      cancel()
      if (fire) cb.current()
    }
    const passive = { passive: true } as const
    window.addEventListener('touchstart', onStart, passive)
    window.addEventListener('touchmove', onMove, passive)
    window.addEventListener('touchend', onEnd, passive)
    window.addEventListener('touchcancel', cancel, passive)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', cancel)
    }
  }, [enabled, threshold])

  return { pull, armed: pull >= threshold }
}

export interface SliceRefreshEntry {
  key: SliceKey
  fetcher: () => Promise<unknown>
}

/** Force-refresh a set of slices the screen owns but does not itself hold. */
export function useSlicesRefresh(entries: SliceRefreshEntry[]): { refresh: () => void; refreshing: boolean } {
  const [refreshing, setRefreshing] = useState(false)
  // The array is rebuilt every render (it names the current watchlist, say) —
  // ref it so `refresh` can stay identity-stable for the gesture hook.
  const list = useRef(entries)
  list.current = entries
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    if (busy.current) return // a second pull mid-flight is not a second refresh
    const jobs = list.current
    if (jobs.length === 0) return
    busy.current = true
    setRefreshing(true)
    void Promise.allSettled(jobs.map(j => revalidate(j.key, j.fetcher, { force: true }))).then(() => {
      busy.current = false
      // A failed refresh still ENDS: `useSlice` owns the offline story (it
      // keeps the cached paint and flips the pill), so this flag's only job is
      // to stop claiming motion that has stopped.
      if (alive.current) setRefreshing(false)
    })
  }, [])

  return { refresh, refreshing }
}
