// FLIP (dynamism wave, feature 8) — rows that MOVE when the ranking moves.
//
// Movers and the Stocks rails re-rank on every refresh, and until now a row
// that climbed six places simply appeared six places up: the one moment in
// this app where something genuinely changed was the moment it showed nothing.
//
// First / Last / Invert / Play, in about forty lines and no library:
//   · FIRST — the positions recorded at the end of the previous render
//   · LAST  — where each row sits now, read in a layout effect (before paint)
//   · INVERT— translate it back to where it was, with transitions off
//   · PLAY  — next frame, drop the transform and let the transition carry it
//
// Only transforms are animated (compositor-only; no layout is touched), and a
// reader who asked for less motion gets none: the JS skips the whole dance and
// the CSS refuses the transition even if it did not.
//
// Rows opt in by carrying `data-flip-key` — a stable identity, the symbol, not
// the index. Keying on position would animate every row on every reorder.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export const FLIP_MS = 200
export const FLIP_CLASS = 'flip-move'

export interface FlipOptions {
  /** Test seam: jsdom's getBoundingClientRect is all zeros, so a test hands in
   * its own ruler. */
  measure?: (el: HTMLElement) => { top: number; left: number }
  /** Test seam for the same reason — jsdom ships no matchMedia. */
  reducedMotion?: () => boolean
}

const defaultMeasure = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left }
}

const defaultReduced = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * @param container the element holding the `[data-flip-key]` rows
 * @param order     the current ranking, joined — the dependency that says
 *                  "something moved"; pass the keys in render order
 */
export function useFlip(container: RefObject<HTMLElement | null>, order: string, opts?: FlipOptions): void {
  const previous = useRef<Map<string, { top: number; left: number }>>(new Map())
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const measure = opts?.measure ?? defaultMeasure
  const reduced = opts?.reducedMotion ?? defaultReduced

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const rows = [...root.querySelectorAll<HTMLElement>('[data-flip-key]')]
    const next = new Map<string, { top: number; left: number }>()
    const still = reduced()
    for (const el of rows) {
      const key = el.dataset.flipKey
      if (!key) continue
      const now = measure(el)
      next.set(key, now)
      const before = previous.current.get(key)
      // A row that was not here last time is ARRIVING, not moving — it has no
      // previous position to come from, and inventing one is a fake.
      if (!before || still) continue
      const dx = before.left - now.left
      const dy = before.top - now.top
      if (dx === 0 && dy === 0) continue
      el.classList.add(FLIP_CLASS)
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      const play = () => {
        el.style.transition = `transform ${FLIP_MS}ms ease`
        el.style.transform = ''
        timers.current.push(
          setTimeout(() => {
            el.style.transition = ''
            el.style.transform = ''
            el.classList.remove(FLIP_CLASS)
          }, FLIP_MS),
        )
      }
      // Next frame, so the browser paints the inverted position first —
      // playing in the same frame is a jump, not a move.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(play)
      else play()
    }
    previous.current = next
  }, [order])

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t)
      timers.current = []
    },
    [],
  )
}
