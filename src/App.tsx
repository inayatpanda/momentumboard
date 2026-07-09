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
import { NavContext, TabBar } from './components/TabBar'
import { useIsWide } from './hooks/useIsWide'

type View =
  | { screen: 'watchlist' }
  | { screen: 'desk' }
  | { screen: 'movers' }
  | { screen: 'detail'; symbol: string; from?: string }
  | { screen: 'journal' }
  | { screen: 'research' }
  | { screen: 'reports' }
  | { screen: 'ledger' }
  | { screen: 'intel' }
  | { screen: 'calendar' }
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

  // if the viewport drops below Desk width (window shrunk, device rotated), fall
  // back to the phone/tablet layout — the Desk is never rendered in a space it
  // wasn't built for.
  useEffect(() => {
    if (!isWide) setView(v => (v.screen === 'desk' ? { screen: 'watchlist' } : v))
  }, [isWide])

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
  }

  const openSettings = () => setView(v => ({ screen: 'settings', from: v.screen }))
  const active = view.screen === 'detail' ? 'charts' : view.screen === 'settings' ? view.from : view.screen === 'ledger' ? 'research' : view.screen
  const reduced = useReducedMotion()
  const screenKey = view.screen + (view.screen === 'detail' ? view.symbol : '')

  // the Desk is full-bleed — it renders outside the 560px .shell and without the
  // tab bar (it carries its own navigation and a "Standard view" escape hatch).
  if (view.screen === 'desk') {
    return (
      <NavContext.Provider value={{ active, navigate }}>
        <Desk key={syncTick} onStandard={() => setView({ screen: 'watchlist' })} onOpenSettings={openSettings} />
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
