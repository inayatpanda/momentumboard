// LIVE QUOTES (dynamism wave, feature 4) — the one place in this app that is
// allowed to poll, and the rules it polls under.
//
// The data layer does not poll, by test-enforced rule (src/lib/store.test.ts
// bans setInterval in store.ts and useSlice.ts): a board is struck once a
// morning and re-fetching it on a timer is waste. A PRICE is different — a card
// that says "entry 18.37" while the tape prints 18.02 is the one number the
// reader actually wants moving.
//
// So this hook polls, and every condition below exists to stop it polling when
// the answer cannot change or the reader cannot see it:
//
//   · document.visibilityState === 'visible' — a backgrounded tab tears the
//     timer down entirely and re-arms on return.
//   · the symbol's own exchange is open (shared/rvol.ts, holiday-aware through
//     parts/SessionLine.tsx's exchangeOpenNow) — out of hours the last close IS
//     the answer, and the card labels it as one rather than faking a tick.
//   · not navigator.connection.saveData — a reader who asked their phone to
//     save data has asked this too.
//   · after ten minutes with no pointer or scroll, the beat drops from 45s to
//     five minutes: an app left open on a desk is not a reader watching it.
//
// It writes through the SAME `quotes:<symbols>` slice machinery everything else
// reads (store.ts's revalidate/readSlice), so a batch already fetched by the
// watchlist costs nothing twice and every mounted reader repaints together.

import { useEffect, useState } from 'react'
import { getQuotes } from './api'
import { readSlice, revalidate } from './store'
import { exchangeFor } from '../../shared/symbols'
import { exchangeOpenNow } from '../screens2/parts/SessionLine'
import type { Quote } from '../../shared/types'

export const LIVE_INTERVAL_MS = 45_000
export const IDLE_INTERVAL_MS = 300_000
/** No pointer, no scroll, this long: nobody is watching. */
export const IDLE_AFTER_MS = 600_000

/** The reader asked their phone to save data. Optional chaining all the way
 * down — `connection` is Chromium-only and `saveData` can be absent on it. */
const saveDataOn = (): boolean =>
  Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)

export function useLiveQuotes(symbols: string[], opts?: { enabled?: boolean }): Record<string, Quote> {
  const enabled = opts?.enabled ?? true
  // ONE stable string is the dependency, never the array: a screen rebuilds
  // that array every render and an array dep would re-arm the timer each time.
  const key = enabled ? symbols.map(s => s.toUpperCase()).join(',') : ''
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})

  useEffect(() => {
    if (!key) {
      setQuotes({})
      return
    }
    const list = key.split(',')
    const sliceKey = `quotes:${key}`
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastActivity = Date.now()

    const apply = (rows: (Quote | null)[] | null | undefined) => {
      if (!alive || !Array.isArray(rows)) return
      const next: Record<string, Quote> = {}
      rows.forEach((q, i) => {
        if (q && list[i]) next[list[i]] = q
      })
      setQuotes(next)
    }

    // Whatever the store already holds, painted at once — the local-first
    // contract, same as useSlice's own first act.
    void readSlice<(Quote | null)[]>(sliceKey)
      .then(r => apply(r?.data))
      .catch(() => {})

    const marketMoving = () => {
      const nowSec = Math.floor(Date.now() / 1000)
      return list.some(s => exchangeOpenNow(exchangeFor(s), nowSec * 1000))
    }
    const mayFetch = () => document.visibilityState === 'visible' && !saveDataOn() && marketMoving()

    const schedule = () => {
      clearTimeout(timer)
      // FULL TEARDOWN ON HIDE: no timer at all behind a hidden tab.
      if (!alive || document.visibilityState !== 'visible') return
      const idle = Date.now() - lastActivity >= IDLE_AFTER_MS
      timer = setTimeout(tick, idle ? IDLE_INTERVAL_MS : LIVE_INTERVAL_MS)
    }

    const tick = async () => {
      if (!alive) return
      // The timer keeps beating while the market is shut but nothing goes out:
      // that is how the first tick after the opening bell arrives on time
      // without a second clock watching for it.
      if (mayFetch()) {
        try {
          await revalidate(sliceKey, () => getQuotes(list), { force: true })
          const r = await readSlice<(Quote | null)[]>(sliceKey)
          apply(r?.data)
        } catch {
          // offline / upstream error: the last good paint stays. `useSlice`
          // owns the offline pill; a quote line must never blank itself.
        }
      }
      schedule()
    }

    const bump = () => {
      // Coming back from idle brings the NEXT beat forward: the pending timer
      // is five minutes long, and a reader who just touched the screen should
      // not wait it out.
      const wasIdle = Date.now() - lastActivity >= IDLE_AFTER_MS
      lastActivity = Date.now()
      if (wasIdle) schedule()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        bump()
        schedule()
      } else {
        clearTimeout(timer)
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointerdown', bump, { passive: true })
    window.addEventListener('scroll', bump, { passive: true })
    schedule()

    return () => {
      alive = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', bump)
      window.removeEventListener('scroll', bump)
    }
  }, [key])

  return quotes
}
