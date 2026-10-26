import { useEffect, useState } from 'react'
import { stockName, stockLabel } from '../../shared/stockNames'
// Load the existing directory once, only when a name is absent. Keep its large
// dataset out of the app's initial download; never fetch one quote per label.
let names: Map<string, string> | undefined
let loading: Promise<Map<string, string>> | undefined
function loadNames() {
  return loading ??= import('../../shared/engine/discovery/universe.seed.json')
    .then(m => names = new Map(m.default.rows.map(row => [row.sym, row.name])))
    .catch(error => { loading = undefined; throw error })
}
export function useStockName(symbol: string, supplied?: string | null) {
  const [, update] = useState(0)
  const name = stockName(symbol, supplied) ?? names?.get(symbol) ?? null
  useEffect(() => {
    if (name) return
    let alive = true
    loadNames().then(() => { if (alive) update(n => n + 1) }).catch(() => {})
    return () => { alive = false }
  }, [symbol, name])
  return name
}
export function StockIdentity({ symbol, name, nameOnly = false }: { symbol: string; name?: string | null; nameOnly?: boolean }) {
  const resolved = useStockName(symbol, name)
  return <>{nameOnly ? resolved : stockLabel(symbol, resolved)}</>
}
