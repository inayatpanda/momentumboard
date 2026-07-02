import type { AlertRule } from './alerts'

export interface AppConfig {
  watchlist: { symbol: string; riskClass: 'normal' | 'speculative'; category?: string }[]
  rules: AlertRule[]
  ytChannels: { id: string; name: string }[]
  capital: number
}

export function validateConfig(raw: unknown): AppConfig | null {
  const c = raw as AppConfig
  if (!c || !Array.isArray(c.watchlist) || !Array.isArray(c.rules) || !Array.isArray(c.ytChannels)) return null
  if (c.watchlist.length > 30) return null
  if (!c.watchlist.every(w => typeof w?.symbol === 'string' && w.symbol.length <= 12)) return null
  c.watchlist = c.watchlist.map(w => ({ ...w, category: typeof w.category === 'string' ? w.category.slice(0, 24) : undefined }))
  if (!c.rules.every(r => typeof r?.id === 'string' && typeof r?.symbol === 'string' && (r.kind === 'priceAbove' || r.kind === 'priceBelow') && typeof r.level === 'number')) return null
  return { watchlist: c.watchlist, rules: c.rules, ytChannels: c.ytChannels, capital: typeof c.capital === 'number' ? c.capital : 5000 }
}
