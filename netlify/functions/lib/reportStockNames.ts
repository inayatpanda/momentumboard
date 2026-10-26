import { loadUniverseSeed } from '../../../shared/engine/discovery/universeSeed'
import { stockLabel, stockName } from '../../../shared/stockNames'
const names = new Map(loadUniverseSeed().map(row => [row.sym, row.name]))
export const reportStockName = (symbol: string, supplied?: string | null) => stockName(symbol, supplied) ?? names.get(symbol) ?? null
export const reportStockLabel = (symbol: string, supplied?: string | null) => stockLabel(symbol, reportStockName(symbol, supplied))
