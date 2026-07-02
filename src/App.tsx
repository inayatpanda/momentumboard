import { useEffect, useState } from 'react'
import { syncFromServer } from './lib/sync'
import { Watchlist } from './screens/Watchlist'
import { TickerDetail } from './screens/TickerDetail'
import { Journal } from './screens/Journal'
import { Research } from './screens/Research'
import { Intel } from './screens/Intel'
import { SettingsScreen } from './screens/SettingsScreen'
import { TabBar } from './components/TabBar'

type View =
  | { screen: 'watchlist' }
  | { screen: 'detail'; symbol: string }
  | { screen: 'journal' }
  | { screen: 'research' }
  | { screen: 'intel' }
  | { screen: 'settings'; from: string }

export default function App() {
  const [view, setView] = useState<View>({ screen: 'watchlist' })
  const [lastSymbol, setLastSymbol] = useState<string | null>(null)
  const [syncTick, setSyncTick] = useState(0)

  // phone ↔ desktop: pull server state on launch; screens remount when it lands
  useEffect(() => {
    syncFromServer().then(changed => changed && setSyncTick(t => t + 1))
  }, [])

  const open = (symbol: string) => {
    setLastSymbol(symbol)
    setView({ screen: 'detail', symbol })
  }

  const navigate = (tab: string) => {
    if (tab === 'watchlist') setView({ screen: 'watchlist' })
    if (tab === 'charts' && lastSymbol) setView({ screen: 'detail', symbol: lastSymbol })
    if (tab === 'journal') setView({ screen: 'journal' })
    if (tab === 'research') setView({ screen: 'research' })
    if (tab === 'intel') setView({ screen: 'intel' })
  }

  const openSettings = () => setView(v => ({ screen: 'settings', from: v.screen }))
  const active = view.screen === 'detail' ? 'charts' : view.screen === 'settings' ? view.from : view.screen

  return (
    <div className="shell" key={syncTick}>
      {view.screen === 'watchlist' && <Watchlist onOpen={open} onOpenSettings={openSettings} />}
      {view.screen === 'detail' && <TickerDetail symbol={view.symbol} onBack={() => setView({ screen: 'watchlist' })} />}
      {view.screen === 'journal' && <Journal />}
      {view.screen === 'research' && <Research onOpenSettings={openSettings} />}
      {view.screen === 'intel' && <Intel onOpenSettings={openSettings} />}
      {view.screen === 'settings' && <SettingsScreen onBack={() => navigate(view.from === 'detail' ? 'watchlist' : view.from)} />}
      <TabBar active={active} chartsReady={!!lastSymbol} onNavigate={navigate} />
    </div>
  )
}
