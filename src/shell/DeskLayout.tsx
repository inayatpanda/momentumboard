// THE DESK (plan Task 22; spec §3.8; ratified mockup option A "master–detail",
// brainstorm/67693-1786687483/content/desktop-layout.html) — at ≥1200px the
// shell becomes three columns: nav rail | board column | detail pane.
//
// AMENDMENT DS-18 — this file is layout CHROME, not a screen. The rail and the
// board column are always mounted; the DETAIL PANE HOSTS THE ROUTED SCREEN,
// which arrives as `children` (AppShell's <Switch/>). So a board row is a
// normal wouter <Link>: the URL changes, deep links and back/forward work, and
// because the layout wraps the outlet rather than the reverse, React never
// remounts the desk around it — the board column keeps its DOM node, its
// slice state and its scroll position across every navigation.
//
// ONE LIVE CHART, by construction: only StockPage mounts PriceChart and only
// one routed screen exists, so the pane can never hold two (asserted in
// DeskLayout.test.tsx anyway — the property is worth pinning, not assuming).
//
// The Analytics drawer is desktop-only and lazy: `AnalyticsPanels` is a
// separate chunk, imported the first time the reader opens it.

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'wouter'
import { Nav } from './Nav'

const BoardColumn = lazy(() => import('../screens2/parts/BoardColumn'))
const AnalyticsPanels = lazy(() => import('./AnalyticsPanels'))

/** The one width that decides the desk, in the shell's own words. It matches
 *  the `@media (min-width: 1200px)` block in src/styles/base.css — change one,
 *  change the other. NOT `src/hooks/useIsWide`: that hook belongs to the
 *  legacy shell (it gates the old Desk screen and dies with it at Task 24's
 *  cutover) and it calls `window.matchMedia` unguarded, which throws in any
 *  environment that ships none — jsdom, for one. */
export const DESK_QUERY = '(min-width: 1200px)'

/** jsdom (and any non-browser render) ships no matchMedia — fall back to the
 *  raw width rather than crashing or silently claiming "desk". */
export function isDeskWidth(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia === 'function') return window.matchMedia(DESK_QUERY).matches
  return window.innerWidth >= 1200
}

/** Reactive desk-width flag: the media query when it exists, plus a resize
 *  listener so a dragged window flips the layout even where change events for
 *  the query are not delivered. */
export function useIsDesk(): boolean {
  const [desk, setDesk] = useState(isDeskWidth)
  useEffect(() => {
    const read = () => setDesk(isDeskWidth())
    read() // the width can have changed between first paint and this effect
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DESK_QUERY) : null
    mql?.addEventListener?.('change', read)
    window.addEventListener('resize', read)
    return () => {
      mql?.removeEventListener?.('change', read)
      window.removeEventListener('resize', read)
    }
  }, [])
  return desk
}

const PanelsFallback = () => (
  <>
    <div className="skeleton" style={{ height: 150, marginBottom: 12 }} />
    <div className="skeleton" style={{ height: 220 }} />
  </>
)

export default function DeskLayout({ children }: { children: ReactNode }) {
  // THE COLUMN EARNS ITS PLACE OR IT LEAVES (owner review of the first DMG,
  // 2026-08-15). Master–detail is the STOCK flow: the board column beside a
  // journey pane, pick a name → it docks. Beside Today it duplicated the same
  // cards twice; beside Stocks/Intel/Record it stole 320px from pages that
  // want the width. So: the column mounts ONLY on /stock/:sym. Every other
  // page gets the full pane. (This also retires the /board pane pointer —
  // /board at desk is simply the Board page, full width, hash and all.)
  const [path] = useLocation()
  const withColumn = path.startsWith('/stock/')
  const [analytics, setAnalytics] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  // closing hands focus back to the button that opened it — the drawer is
  // non-modal, so nothing else about the page is trapped while it is open
  const close = useCallback(() => {
    setAnalytics(false)
    toggleRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!analytics) return
    drawerRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [analytics, close])

  return (
    <div className={withColumn ? 'desk2' : 'desk2 desk2-wide'}>
      <div className="desk2-rail">
        <Nav />
      </div>

      {withColumn && (
        <aside className="desk2-board" aria-label="Board column">
          <header className="desk2-colhead">
            <span className="sec-label">Board</span>
          </header>
          <Suspense
            fallback={
              <>
                <div className="skeleton" style={{ height: 118, marginBottom: 10 }} />
                <div className="skeleton" style={{ height: 118 }} />
              </>
            }
          >
            <BoardColumn />
          </Suspense>
        </aside>
      )}

      <main className="v2-page desk2-detail">
        <div className="desk2-panebar">
          <button
            type="button"
            ref={toggleRef}
            className="mini-btn ghost desk2-analytics-btn"
            aria-expanded={analytics}
            onClick={() => setAnalytics(v => !v)}
          >
            Analytics
          </button>
        </div>
        {children}
      </main>

      {analytics && (
        <aside className="desk2-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="false" aria-label="Analytics">
          <header className="desk2-drawer-head">
            <span className="sec-label">Analytics</span>
            <button type="button" className="mini-btn ghost" onClick={close}>
              Close
            </button>
          </header>
          <Suspense fallback={<PanelsFallback />}>
            <AnalyticsPanels />
          </Suspense>
        </aside>
      )}
    </div>
  )
}
