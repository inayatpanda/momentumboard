// THE v2 SHELL (plan Task 10; CX-3/9/11, DS-8). Mounted by App.tsx inside the
// licensed /app surface — licence and public-site ownership STAY in App.tsx.
// wouter under base /app: real URLs, browser back/forward, deep links. The
// catch-all sends unknown paths home rather than 404ing an installed PWA.

import { Suspense, useEffect } from 'react'
import { Redirect, Route, Router, Switch } from 'wouter'
import type { BaseLocationHook } from 'wouter'
import '../styles/base.css'
import { gcSlices } from '../lib/store'
import DeskLayout, { useIsDesk } from './DeskLayout'
import { Nav } from './Nav'
import { OfflinePill } from './OfflinePill'
import { UpdateBanner } from './UpdateBanner'
import { ROUTES } from './routes'
import { ChunkRecoveryBoundary } from './ChunkRecoveryBoundary'

const PageFallback = () => (
  <div style={{ padding: 24 }}>
    <div className="skeleton" style={{ height: 28, width: '40%', marginBottom: 14 }} />
    <div className="skeleton" style={{ height: 96, marginBottom: 10 }} />
    <div className="skeleton" style={{ height: 96 }} />
  </div>
)

export default function AppShell({ locationHook }: { locationHook?: BaseLocationHook }) {
  useEffect(() => {
    void gcSlices().catch(() => {})
  }, [])
  // ≥1200px: the routed screen renders inside the desk's detail pane (DS-18 —
  // the layout wraps the outlet, never the reverse, so navigating between
  // screens leaves the rail and the board column mounted). Below 1200px this
  // shell is byte-for-byte what it was: one page column and the bottom tabs.
  const desk = useIsDesk()
  const outlet = (
    <ChunkRecoveryBoundary>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          {ROUTES.map(r =>
            r.path.includes(':') ? (
              <Route key={r.path} path={r.path}>
                {params => {
                  const C = r.component as React.ComponentType<{ sym: string }>
                  return <C sym={String((params as { sym?: string }).sym ?? '').toUpperCase()} />
                }}
              </Route>
            ) : (
              <Route key={r.path} path={r.path} component={r.component as React.ComponentType} />
            ),
          )}
          <Route>
            <Redirect to="/" />
          </Route>
        </Switch>
      </Suspense>
    </ChunkRecoveryBoundary>
  )
  return (
    <div className="v2">
      <Router base="/app" hook={locationHook}>
        <OfflinePill />
        <UpdateBanner />
        {desk ? (
          <DeskLayout>{outlet}</DeskLayout>
        ) : (
          <>
            <main className="v2-page">{outlet}</main>
            <Nav />
          </>
        )}
      </Router>
    </div>
  )
}
