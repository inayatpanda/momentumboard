import type { AlertRule } from './alerts'
import type { LevMap } from './engine/riskLadder'

export interface UserNote {
  id: string
  text: string
  kind: 'observation' | 'lesson' | 'hypothesis'
  ticker?: string
  at: number
}

export interface AppConfig {
  watchlist: { symbol: string; riskClass: 'normal' | 'speculative'; category?: string }[]
  rules: AlertRule[]
  ytChannels: { id: string; name: string }[]
  capital: number
  notes?: UserNote[]
  levMap?: LevMap // underlying → ISA-eligible leveraged/inverse ETP tickers
  riskRungOverride?: 0 | 1 | 2 | 3 | null // manual risk-ladder pin; null = engine decides
  favouriteChannels?: string[] // credibility prior 0.6 instead of 0.5
  riskAppetite?: 'moderate' | 'aggressive' // engine gates: aggressive widens the funnel (catalyst.ts). Default moderate.
}

export function validateConfig(raw: unknown): AppConfig | null {
  const c = raw as AppConfig
  if (!c || !Array.isArray(c.watchlist) || !Array.isArray(c.rules) || !Array.isArray(c.ytChannels)) return null
  if (c.watchlist.length > 30) return null
  if (!c.watchlist.every(w => typeof w?.symbol === 'string' && w.symbol.length <= 12)) return null
  c.watchlist = c.watchlist.map(w => ({ ...w, category: typeof w.category === 'string' ? w.category.slice(0, 24) : undefined }))
  if (!c.rules.every(r => typeof r?.id === 'string' && typeof r?.symbol === 'string' && (r.kind === 'priceAbove' || r.kind === 'priceBelow') && typeof r.level === 'number')) return null
  const notes = Array.isArray(c.notes)
    ? c.notes
        .filter(n => typeof n?.text === 'string' && typeof n?.id === 'string')
        .slice(0, 50)
        .map(n => ({
          id: n.id,
          text: n.text.slice(0, 500),
          kind: n.kind === 'lesson' || n.kind === 'hypothesis' ? n.kind : ('observation' as const),
          ticker: typeof n.ticker === 'string' ? n.ticker.toUpperCase().slice(0, 12) : undefined,
          at: typeof n.at === 'number' ? n.at : 0,
        }))
    : undefined
  const levMap: LevMap = {}
  if (c.levMap && typeof c.levMap === 'object') {
    for (const [sym, m] of Object.entries(c.levMap).slice(0, 40)) {
      if (!m || typeof m !== 'object') continue
      const entry: LevMap[string] = {}
      for (const k of ['long2x', 'long3x', 'short2x', 'short3x'] as const) {
        const v = (m as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.length) entry[k] = v.toUpperCase().slice(0, 12)
      }
      if (Object.keys(entry).length) levMap[sym.toUpperCase().slice(0, 12)] = entry
    }
  }
  // ABSENT (undefined) must stay undefined so a server-side merge can preserve a
  // stored pin — the phone's config mirror never sends this field. An explicit
  // null (or any present-but-invalid value) means "engine decides" → null.
  const riskRungOverride: 0 | 1 | 2 | 3 | null | undefined =
    typeof c.riskRungOverride === 'number' && Number.isInteger(c.riskRungOverride) && c.riskRungOverride >= 0 && c.riskRungOverride <= 3
      ? (c.riskRungOverride as 0 | 1 | 2 | 3)
      : c.riskRungOverride === undefined
        ? undefined
        : null
  const favouriteChannels = Array.isArray(c.favouriteChannels)
    ? c.favouriteChannels.filter(f => typeof f === 'string').slice(0, 10).map(f => f.slice(0, 40))
    : undefined
  const riskAppetite = c.riskAppetite === 'aggressive' ? 'aggressive' : c.riskAppetite === 'moderate' ? 'moderate' : undefined
  return {
    watchlist: c.watchlist,
    rules: c.rules,
    ytChannels: c.ytChannels,
    capital: typeof c.capital === 'number' ? c.capital : 5000,
    notes,
    levMap: Object.keys(levMap).length ? levMap : undefined,
    riskRungOverride,
    favouriteChannels,
    riskAppetite,
  }
}
