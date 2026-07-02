import { useState } from 'react'
import { Watchlist } from './screens/Watchlist'
import { TickerDetail } from './screens/TickerDetail'
import { Journal } from './screens/Journal'
import { Digest } from './screens/Digest'
import { TabBar } from './components/TabBar'

type View = { screen: 'watchlist' } | { screen: 'detail'; symbol: string } | { screen: 'journal' } | { screen: 'digest' }

export default function App() {
  const [view, setView] = useState<View>({ screen: 'watchlist' })
  const [lastSymbol, setLastSymbol] = useState<string | null>(null)

  const open = (symbol: string) => {
    setLastSymbol(symbol)
    setView({ screen: 'detail', symbol })
  }

  const navigate = (tab: string) => {
    if (tab === 'watchlist') setView({ screen: 'watchlist' })
    if (tab === 'charts' && lastSymbol) setView({ screen: 'detail', symbol: lastSymbol })
    if (tab === 'journal') setView({ screen: 'journal' })
    if (tab === 'digest') setView({ screen: 'digest' })
  }

  const active = view.screen === 'detail' ? 'charts' : view.screen

  return (
    <div className="shell">
      {view.screen === 'watchlist' && <Watchlist onOpen={open} />}
      {view.screen === 'detail' && <TickerDetail symbol={view.symbol} onBack={() => setView({ screen: 'watchlist' })} />}
      {view.screen === 'journal' && <Journal />}
      {view.screen === 'digest' && <Digest />}
      <TabBar active={active} chartsReady={!!lastSymbol} onNavigate={navigate} />
    </div>
  )
}
