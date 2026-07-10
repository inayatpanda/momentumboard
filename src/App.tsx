import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { syncFromServer } from './lib/sync'
import { seedStarterWatchlist } from './lib/starter'
import { Watchlist } from './screens/Watchlist'
import { Movers } from './screens/Movers'
import { TickerDetail } from './screens/TickerDetail'
import { Journal } from './screens/Journal'
import { Research } from './screens/Research'
import { Reports } from './screens/Reports'
import { Ledger } from './screens/Ledger'
import { Intel } from './screens/Intel'
import { CalendarScreen } from './screens/CalendarScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { Desk } from './screens/Desk'
import { Quant } from './screens/Quant'
import { Landing } from './screens/Landing'
import { More } from './screens/More'
import { NavContext, TabBar } from './components/TabBar'
import { useIsWide } from './hooks/useIsWide'
import { clearToken, getToken, validateAccess } from './lib/api'
import { onInstallAvailable, promptInstall } from './lib/installPrompt'

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
  | { screen: 'intel' }
  | { screen: 'calendar' }
  | { screen: 'more' }
  | { screen: 'settings'; from: string }

export default function App() {
  // wide screens open straight onto the Desk dashboard; phones/tablets get the
  // classic tabbed layout. Read matchMedia in the initialiser so there's no flash.
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1200px)').matches ? { screen: 'desk' } : { screen: 'watchlist' },
  )
  const isWide = useIsWide(1200)
  const [lastSymbol, setLastSymbol] = useState<string | null>(null)
  const [syncTick, setSyncTick] = useState(0)
  // licence gate: no token → the public landing page. main.tsx consumes ?key=
  // unlock links before React mounts, so licensed arrivals never see it.
  const [licensed, setLicensed] = useState(() => !!getToken())
  // browser-tab vs installed-app disambiguation: same URL serves both, which
  // confuses readers who typed the address. In a plain tab we say so and offer
  // the public site; the installed app (standalone) never shows any of this.
  const inBrowserTab = typeof window !== 'undefined' && !window.matchMedia('(display-mode: standalone)').matches
  const [siteView, setSiteView] = useState(false)
  const [browserNoteDismissed, setBrowserNoteDismissed] = useState(() => sessionStorage.getItem('mb-browser-note') === '1')
  const [canInstall, setCanInstall] = useState(false)
  useEffect(() => onInstallAvailable(setCanInstall), [])

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
    if (!licensed) return
    history.replaceState({ ss: 'root' }, '')
    history.pushState({ ss: 'buffer' }, '')
    const onPop = () => {
      let consumed = false
      setSiteView(false)
      setView(v => {
        const home: View = window.matchMedia('(min-width: 1200px)').matches ? { screen: 'desk' } : { screen: 'watchlist' }
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
        if (v.screen === 'research' || v.screen === 'reports' || v.screen === 'intel' || v.screen === 'calendar' || v.screen === 'ledger') {
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
  }, [licensed])

  // phone ↔ desktop: pull server state on launch; screens remount when it lands.
  // Starter seeding runs AFTER the pull, so an existing watchlist is never
  // polluted — a truly first launch gets the classics instead of a blank page.
  useEffect(() => {
    syncFromServer().then(async changed => {
      const seeded = await seedStarterWatchlist().catch(() => false)
      if (changed || seeded) setSyncTick(t => t + 1)
    })
  }, [])

  const open = (symbol: string) => {
    setLastSymbol(symbol)
    // remember where the chart was opened from, so Back returns there
    setView(v => ({ screen: 'detail', symbol, from: v.screen === 'detail' ? v.from : v.screen }))
  }

  const navigate = (tab: string) => {
    if (tab === 'desk') setView({ screen: 'desk' })
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
  }

  const openSettings = () => setView(v => ({ screen: 'settings', from: v.screen }))
  const active = view.screen === 'detail' ? 'charts' : view.screen === 'settings' ? view.from : view.screen
  const reduced = useReducedMotion()
  const screenKey = view.screen + (view.screen === 'detail' ? view.symbol : '')

  // the licence gate comes before everything — unlicensed visitors get the
  // public marketing page, whatever the viewport.
  if (!licensed) {
    return <Landing onUnlocked={() => setLicensed(true)} />
  }

  // a licensed reader who chose "View website" from the browser strip
  if (siteView) {
    return <Landing licensed onUnlocked={() => setSiteView(false)} />
  }

  // the Desk is full-bleed — it renders outside the 560px .shell and without the
  // tab bar (it carries its own navigation and a "Standard view" escape hatch).
  if (view.screen === 'desk') {
    return (
      <NavContext.Provider value={{ active, navigate }}>
        <Desk
          key={syncTick}
          onStandard={() => setView({ screen: 'watchlist' })}
          onQuant={() => setView({ screen: 'quant' })}
          onOpenSettings={openSettings}
        />
      </NavContext.Provider>
    )
  }

  if (view.screen === 'quant') {
    return (
      <NavContext.Provider value={{ active, navigate }}>
        <Quant key={syncTick} onBack={() => setView({ screen: 'desk' })} onOpenSettings={openSettings} />
      </NavContext.Provider>
    )
  }

  return (
    <NavContext.Provider value={{ active, navigate }}>
    <div className="shell" key={syncTick}>
      {inBrowserTab && !isWide && !browserNoteDismissed && (
        <div className="browser-note" role="note">
          <span>Browser view — the installed app has its own icon.</span>
          {canInstall && (
            <button
              onClick={async () => {
                if (await promptInstall()) setBrowserNoteDismissed(true)
              }}
            >
              Install app
            </button>
          )}
          <button onClick={() => setSiteView(true)}>View website</button>
          <button
            aria-label="Dismiss"
            onClick={() => {
              sessionStorage.setItem('mb-browser-note', '1')
              setBrowserNoteDismissed(true)
            }}
          >
            ✕
          </button>
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screenKey}
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
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
          {view.screen === 'intel' && <Intel onOpenSettings={openSettings} />}
          {view.screen === 'calendar' && <CalendarScreen onOpenSettings={openSettings} />}
          {view.screen === 'more' && <More onOpenSettings={openSettings} />}
          {view.screen === 'settings' && <SettingsScreen onBack={() => navigate(view.from === 'detail' ? 'watchlist' : view.from)} />}
        </motion.div>
      </AnimatePresence>
      <TabBar active={active} chartsReady={!!lastSymbol} onNavigate={navigate} />
      {isWide && view.screen !== 'settings' && (
        <button className="desk-return" onClick={() => setView({ screen: 'desk' })} title="Open the Desk dashboard">
          ⊞ Desk
        </button>
      )}
    </div>
    </NavContext.Provider>
  )
}
