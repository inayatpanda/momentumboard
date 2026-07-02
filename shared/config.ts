import type { AlertRule } from './alerts'

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
  return { watchlist: c.watchlist, rules: c.rules, ytChannels: c.ytChannels, capital: typeof c.capital === 'number' ? c.capital : 5000, notes }
}
