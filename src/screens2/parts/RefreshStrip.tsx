// THE REFRESH AFFORDANCE (dynamism wave, feature 3) — what a pull looks like,
// and what a desk reader presses instead.
//
// A thin bar across the very top of the viewport, and nothing else: a spinner
// in the middle of a screen implies the screen is empty, and it never is (the
// local-first contract paints from Dexie first — src/lib/useSlice.ts). Three
// states, in order of truth:
//
//   · fetching  — an indeterminate sweep, announced as a live status
//   · pulling   — the bar fills with the gesture, so the reader can see the
//                 threshold arrive rather than guess at it
//   · idle      — no element at all
//
// The button is desk-only in CSS (a phone has the gesture) but always in the
// DOM: it is the accessible way to do this, and a touch laptop can use both.

import { PULL_THRESHOLD } from '../../lib/usePullRefresh'

export function RefreshStrip({
  refreshing,
  pull = 0,
  threshold = PULL_THRESHOLD,
  onRefresh,
}: {
  refreshing: boolean
  pull?: number
  threshold?: number
  onRefresh: () => void
}) {
  const ratio = Math.max(0, Math.min(1, pull / threshold))
  return (
    <>
      {refreshing ? (
        <div className="rf-bar rf-bar-busy" role="status" aria-label="Refreshing" />
      ) : ratio > 0 ? (
        <div className="rf-bar rf-bar-pull" style={{ transform: `scaleX(${ratio})` }} data-armed={ratio >= 1 ? '' : undefined} aria-hidden="true" />
      ) : null}
      <button type="button" className="rf-btn" onClick={onRefresh} aria-label="Refresh" disabled={refreshing}>
        ↻
      </button>
    </>
  )
}
