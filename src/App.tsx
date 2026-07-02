import { useState } from 'react'
import { Watchlist } from './screens/Watchlist'
import { TickerDetail } from './screens/TickerDetail'
import { TabBar } from './components/TabBar'

type View = { screen: 'watchlist' } | { screen: 'detail'; symbol: string }

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
  }

  return (
    <div className="shell">
      {view.screen === 'watchlist' ? (
        <Watchlist onOpen={open} />
      ) : (
        <TickerDetail symbol={view.symbol} onBack={() => setView({ screen: 'watchlist' })} />
      )}
      <TabBar active={view.screen === 'watchlist' ? 'watchlist' : 'charts'} chartsReady={!!lastSymbol} onNavigate={navigate} />
    </div>
  )
}
