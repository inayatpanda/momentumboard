import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { syncFromServer } from './lib/sync'
import { seedStarterWatchlist } from './lib/starter'
import { Watchlist } from './screens/Watchlist'
import { Movers } from './screens/Movers'
import { Intel } from './screens/Intel'
import { SettingsScreen } from './screens/SettingsScreen'
import { Landing } from './screens/Landing'
import { AppGate } from './screens/AppGate'
import { EnginePage, FaqPage, LedgerPage, PaperPage, siteRouteFor } from './screens/SitePages'
import { More } from './screens/More'
// Lazily loaded (audit L-1): the chart-heavy and secondary screens ship in
// their own chunks, and the charting library rides with them — so the initial
// bundle (the mobile Signals/Watchlist first paint) no longer carries it.
const TickerDetail = lazy(() => import('./screens/TickerDetail').then(m => ({ default: m.TickerDetail })))
const Journal = lazy(() => import('./screens/Journal').then(m => ({ default: m.Journal })))
const Research = lazy(() => import('./screens/Research').then(m => ({ default: m.Research })))
const Reports = lazy(() => import('./screens/Reports').then(m => ({ default: m.Reports })))
const Ledger = lazy(() => import('./screens/Ledger').then(m => ({ default: m.Ledger })))
const CalendarScreen = lazy(() => import('./screens/CalendarScreen').then(m => ({ default: m.CalendarScreen })))
const Desk = lazy(() => import('./screens/Desk').then(m => ({ default: m.Desk })))
const Quant = lazy(() => import('./screens/Quant').then(m => ({ default: m.Quant })))
const Positions = lazy(() => import('./screens/Positions').then(m => ({ default: m.Positions })))

const ScreenFallback = () => <p className="empty-line" style={{ padding: 24 }}>Loading…</p>
// The v2 shell (PWA rebuild) — THE shell since the cutover. Static import on
// purpose: it folds the shell + base.css into the entry, so a first-visit
// install that goes offline before opening still has the whole app (the
// walkthrough's precache covers the entry closure).
import AppShell from './shell/AppShell'
import { NavContext, TabBar } from './components/TabBar'
import { useIsWide } from './hooks/useIsWide'
import { clearToken, getToken, validateAccess } from './lib/api'

type View =
  | { screen: 'watchlist' }
  | { screen: 'desk' }
  | { screen: 'quant' }
  | { screen: 'movers' }
  | { screen: 'detail'; symbol: string; from?: string }
  | { screen: 'journal' }
  | { screen: 'research' }
  | { screen: 'reports' }
  | { screen: 'ledger' }
  | { screen: 'positions' }
  | { screen: 'intel' }
  | { screen: 'calendar' }
  | { screen: 'more' }
  | { screen: 'settings'; from: string }

export default function App() {
  // `/` is always the public website; `/app/` is the product/PWA. Keeping the
  // surfaces on separate paths stops an installed PWA claiming a normal visit
  // to the website and makes the reader's intent explicit.
  const [surface, setSurface] = useState<'site' | 'app'>(() => (location.pathname.startsWith('/app') ? 'app' : 'site'))
  // wide screens open straight onto the Desk dashboard; phones/tablets get the
  // classic tabbed layout. Read matchMedia in the initialiser so there's no
  // flash. `mb-home` remembers a reader who chose Standard view — before it,
  // every desktop launch forced the Desk back on them.
  const homeView = (): View =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1200px)').matches && localStorage.getItem('mb-home') !== 'standard'
      ? { screen: 'desk' }
      : { screen: 'watchlist' }
  const [view, setView] = useState<View>(homeView)
  const isWide = useIsWide(1200)
  const [lastSymbol, setLastSymbol] = useState<string | null>(null)
  const [syncTick, setSyncTick] = useState(0)
  // licence gate: no token → the public landing page. main.tsx consumes ?key=
  // unlock links before React mounts, so licensed arrivals never see it.
  const [licensed, setLicensed] = useState(() => !!getToken())
  const enterApp = () => {
    history.replaceState(null, '', '/app/')
    setSurface('app')
    setLicensed(true)
  }

  // boot check: a token the server rejects (revoked, or an expired trial) sends
  // the reader back to the landing page instead of a screen of failed requests.
  // Offline resolves valid — never lock a licensed reader out of cached data.
  // MOUNT-ONLY on purpose: a trial minted seconds ago can 401 on a stale Blobs
  // replica (eventual consistency); re-validating on the unlock transition
  // silently bounced fresh trials back to the landing. By the next visit the
  // write has long propagated, so the boot check still catches real expiry.
  useEffect(() => {
    if (!getToken()) return
    validateAccess().then(ok => {
      if (!ok) {
        // a key claimed minutes ago can 401 off a stale Blobs replica even
        // with the server's strong-read retry — never burn a fresh unlock on
        // one bad answer; real expiry/revocation still catches the next boot
        const claimedAt = Number(localStorage.getItem('mb-token-at') ?? 0)
        if (Date.now() - claimedAt < 15 * 60_000) return
        clearToken()
        setLicensed(false)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // if the viewport drops below Desk width (window shrunk, device rotated), fall
  // back to the phone/tablet layout — the Desk is never rendered in a space it
  // wasn't built for.
  useEffect(() => {
    if (!isWide) setView(v => (v.screen === 'desk' || v.screen === 'quant' ? { screen: 'watchlist' } : v))
  }, [isWide])

  // Android back: an SPA with no history stack means the hardware back gesture
  // closes the app (or falls back to the browser window). Keep ONE buffer entry
  // armed: back from any screen → home (re-armed); back again from home → the
  // root entry, which exits — standard Android app behaviour.
  useEffect(() => {
    if (!licensed || surface !== 'app') return
    history.replaceState({ ss: 'root' }, '')
    history.pushState({ ss: 'buffer' }, '')
    const onPop = () => {
      let consumed = false
      setView(v => {
        const home: View = homeView()
        if (v.screen === home.screen) return v // already home: let the next back exit
        consumed = true
        // retrace, don't teleport: a chart returns to whatever opened it, the
        // reading sections return to their More menu, everything else goes home
        if (v.screen === 'detail') {
          const f = v.from
          if (f === 'ledger') return { screen: 'ledger' }
          if (f && f !== 'detail' && f !== 'settings' && f !== home.screen) return { screen: f } as View
          return home
        }
        if (v.screen === 'settings') return v.from && v.from !== 'detail' && v.from !== home.screen ? ({ screen: v.from } as View) : home
        if (v.screen === 'research' || v.screen === 'reports' || v.screen === 'intel' || v.screen === 'calendar' || v.screen === 'ledger' || v.screen === 'positions') {
          return { screen: 'more' }
        }
        return home
      })
      // re-arm the buffer only when the back was used for in-app navigation
      setTimeout(() => {
        if (consumed) history.pushState({ ss: 'buffer' }, '')
      }, 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [licensed, surface])

  // phone ↔ desktop: pull server state on launch; screens remount when it lands.
  // Starter seeding runs AFTER the pull, so an existing watchlist is never
  // polluted — a truly first launch gets the classics instead of a blank page.
  //
  // `syncTick` is THIS shell's mechanism and stays exactly as it was: the legacy
  // screens hold their own state and only a remount refreshes them. The v2
  // screens need nothing from here — `syncFromServer` announces its own slice
  // invalidation (DS-10/CX-22, src/lib/sync.ts), so both shells are served
  // whichever one is mounted.
  useEffect(() => {
    if (!licensed || surface !== 'app') return
    syncFromServer().then(async changed => {
      const seeded = await seedStarterWatchlist().catch(() => false)
      if (changed || seeded) setSyncTick(t => t + 1)
    })
  }, [licensed, surface])

  const open = (symbol: string) => {
    setLastSymbol(symbol)
    // remember where the chart was opened from, so Back returns there
    setView(v => ({ screen: 'detail', symbol, from: v.screen === 'detail' ? v.from : v.screen }))
  }

  const navigate = (tab: string) => {
    // choosing the Desk from the rail is choosing it as the wide-screen home
    if (tab === 'desk') {
      localStorage.setItem('mb-home', 'desk')
      setView({ screen: 'desk' })
    }
    if (tab === 'quant') setView({ screen: 'quant' })
    if (tab === 'watchlist') setView({ screen: 'watchlist' })
    if (tab === 'movers') setView({ screen: 'movers' })
    // Charts continues where you left off; before anything's been opened it
    // shows the market itself rather than sitting dead
    if (tab === 'charts') setView(v => ({ screen: 'detail', symbol: lastSymbol ?? 'SPY', from: v.screen === 'detail' ? v.from : v.screen }))
    if (tab === 'journal') setView({ screen: 'journal' })
    if (tab === 'research') setView({ screen: 'research' })
    if (tab === 'reports') setView({ screen: 'reports' })
    if (tab === 'intel') setView({ screen: 'intel' })
    if (tab === 'calendar') setView({ screen: 'calendar' })
    if (tab === 'more') setView({ screen: 'more' })
    if (tab === 'ledger') setView({ screen: 'ledger' })
    if (tab === 'positions') setView({ screen: 'positions' })
    // the desktop rail's Settings row (mobile reaches Settings through More)
    if (tab === 'settings') setView(v => ({ screen: 'settings', from: v.screen === 'settings' ? v.from : v.screen }))
  }

  const openSettings = () => setView(v => ({ screen: 'settings', from: v.screen }))
  // settings is its own key: the desktop rail has a Settings row to light up,
  // and on mobile it sits behind More (MORE_KEYS covers the More highlight)
  const active = view.screen === 'detail' ? 'charts' : view.screen
  const reduced = useReducedMotion()
  const screenKey = view.screen + (view.screen === 'detail' ? view.symbol : '')

  // The public URL stays the public website even on a licensed device. A clear
  // Open app action moves to `/app/`; licence links do this automatically.
  // Sub-pages (/engine, /paper, /ledger, /faq) are real URLs — the netlify.toml
  // catch-all serves index.html and the path picks the page here.
  if (surface === 'site') {
    const page = siteRouteFor(location.pathname)
    if (page === 'engine') return <EnginePage />
    if (page === 'paper') return <PaperPage />
    if (page === 'ledger') return <LedgerPage />
    if (page === 'faq') return <FaqPage />
    return <Landing licensed={licensed} onUnlocked={enterApp} />
  }

  // an unlicensed device AT /app/ gets the app's own front door — never the
  // marketing website (that lives on the site surface above; the two are
  // different things, especially inside the desktop shell)
  if (!licensed) {
    return <AppGate onUnlocked={enterApp} />
  }

  // THE CUTOVER (plan Task 24): the v2 shell IS the app. Licence and the
  // public site stay THIS component's job (DS-8). The legacy shell below is
  // reachable only via the "Classic shell" escape hatch in Settings
  // (mb-shell='v1') until the deletion wave removes both it and the flag.
  if (localStorage.getItem('mb-shell') !== 'v1') {
    return (
      <Suspense fallback={<ScreenFallback />}>
        <AppShell />
      </Suspense>
    )
  }

  // the Desk is full-bleed content-wise, but it KEEPS the navigation rail —
  // losing every other tab on entering the Desk made the app feel like two
  // apps. The rail is fixed-position, so the .desk container pads for it ≥1024.
  if (view.screen === 'desk') {
    return (
      <NavContext.Provider value={{ active, navigate }}>
        <TabBar active="desk" onNavigate={navigate} />
        <Suspense fallback={<ScreenFallback />}>
          <Desk
            key={syncTick}
            onStandard={() => {
              localStorage.setItem('mb-home', 'standard')
              setView({ screen: 'watchlist' })
            }}
            onQuant={() => setView({ screen: 'quant' })}
            onOpen={open}
          />
        </Suspense>
      </NavContext.Provider>
    )
  }

  if (view.screen === 'quant') {
    return (
      <NavContext.Provider value={{ active, navigate }}>
        <TabBar active="desk" onNavigate={navigate} />
        <Suspense fallback={<ScreenFallback />}>
          <Quant key={syncTick} onBack={() => setView({ screen: 'desk' })} onOpen={open} />
        </Suspense>
      </NavContext.Provider>
    )
  }

  return (
    <NavContext.Provider value={{ active, navigate }}>
    <div className="shell" key={syncTick}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screenKey}
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          <Suspense fallback={<ScreenFallback />}>
          {view.screen === 'watchlist' && <Watchlist onOpen={open} onOpenSettings={openSettings} />}
          {view.screen === 'movers' && <Movers onOpen={open} onOpenSettings={openSettings} />}
          {view.screen === 'detail' && (
            <TickerDetail
              symbol={view.symbol}
              onBack={() => {
                const f = view.from
                if (f === 'ledger') setView({ screen: 'ledger' })
                else if (f && f !== 'detail' && f !== 'settings') navigate(f)
                else setView({ screen: 'watchlist' })
              }}
            />
          )}
          {view.screen === 'journal' && <Journal />}
          {view.screen === 'research' && <Research onOpenSettings={openSettings} onOpenLedger={() => setView({ screen: 'ledger' })} />}
          {view.screen === 'reports' && <Reports onOpenSettings={openSettings} />}
          {view.screen === 'ledger' && <Ledger onBack={() => setView({ screen: 'research' })} onOpen={open} />}
          {view.screen === 'positions' && <Positions onOpen={open} onOpenSettings={openSettings} />}
          {view.screen === 'intel' && <Intel onOpenSettings={openSettings} />}
          {view.screen === 'calendar' && <CalendarScreen onOpenSettings={openSettings} />}
          {view.screen === 'more' && <More onOpenSettings={openSettings} />}
          {view.screen === 'settings' && <SettingsScreen onBack={() => navigate(view.from === 'detail' ? 'watchlist' : view.from)} />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
      <TabBar active={active} chartsReady={!!lastSymbol} onNavigate={navigate} />
    </div>
    </NavContext.Provider>
  )
}
