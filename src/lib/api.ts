import type { ApiEnvelope, Candle, Quote } from '../../shared/types'
import type { AppConfig } from '../../shared/config'

export const getToken = () => localStorage.getItem('mb-token')
export const setToken = (t: string) => localStorage.setItem('mb-token', t)

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'x-app-token': getToken() ?? '' } })
  const body = (await res.json()) as ApiEnvelope<T>
  if (!body.ok || body.data === undefined) throw new Error(body.error ?? `http-${res.status}`)
  return body.data
}

export const getQuotes = (symbols: string[]) =>
  apiGet<{ quotes: (Quote | null)[] }>(`/api/market?type=quote&symbols=${symbols.join(',')}`).then(d => d.quotes)

export const getCandles = (symbol: string, range = '1y') =>
  apiGet<{ candles: Candle[]; quote: Quote }>(`/api/market?type=candles&symbol=${encodeURIComponent(symbol)}&range=${range}`)

export const getCalendar = (symbols: string[]) =>
  apiGet<{ earnings: { symbol: string; date: string; hour: string; epsEstimate: number | null }[] }>(`/api/market?type=calendar&symbols=${symbols.join(',')}`).then(d => d.earnings)

export const getFeed = () =>
  apiGet<{ news: { title: string; url: string; symbols: string[] }[]; videos: { title: string; url: string; channel: string }[] }>('/api/market?type=feed')

export const resolveChannel = (handle: string) =>
  apiGet<{ id: string; name: string }>(`/api/market?type=resolve-channel&handle=${encodeURIComponent(handle)}`)

export const getInsiders = (symbols: string[]) =>
  apiGet<{ insiders: { symbol: string; buyers: string[]; totalValueUsd: number; isCluster: boolean; latest: { name: string; shares: number; date: string }[] }[] }>(`/api/market?type=insiders&symbols=${symbols.join(',')}`).then(d => d.insiders)

export const getSignalStats = () =>
  apiGet<{ scores: { setup: string; n: number; scored: number; win5: number | null; avg5: number | null; avg10: number | null }[]; totalSignals: number }>('/api/market?type=signal-stats')

export const getSmartMoney = () =>
  apiGet<{ funds: { fund: string; filedAt: string; newPositions: { issuer: string }[]; increased: { issuer: string; pctChange: number }[]; exited: { issuer: string }[] }[]; lagNote: string }>('/api/market?type=smart-money')

interface PulseRow {
  sym: string
  name?: string
  redditRank: number | null
  redditMentions: number | null
  surging: boolean
  surgeMultiple: number | null
  stocktwits: boolean
  channelNet: number | null
  sources: number
  onWatchlist: boolean
}

export const getSocialPulse = () =>
  apiGet<{
    discoveries: (PulseRow & { capUsdM: number | null; companyName?: string; opinion?: string })[]
    alsoLoud: string[]
    pulse: PulseRow[]
    at: number
  }>('/api/market?type=social')

export const getEcon = () =>
  apiGet<{ events: { title: string; country: string; at: number; impact: string }[] }>('/api/market?type=econ').then(d => d.events)

export const getTrending = () =>
  apiGet<{ current: { at: number; watchlist: { sym: string; changePct: number; rvol: number | null; setups: string[] }[]; market: { sym: string; changePct: number | null }[] } | null; timeline: unknown[] }>('/api/config?view=trending')

export const getOutcomes = () =>
  apiGet<{ date: string; regime?: string; picks: { ticker: string; side: string; strength?: string; conviction?: string; priceAtPick?: number; f5: number | null; f10: number | null }[] }[]>('/api/config?view=outcomes')

export const getPickStats = () =>
  apiGet<{ scores: { bucket: string; n: number; scored: number; win5: number | null; avg5: number | null; avg10: number | null }[]; reports: number }>('/api/market?type=pick-stats')

export const getPicks = () =>
  apiGet<{ persistence: { ticker: string; side: 'long' | 'short'; appearances: number; streak: number; latestConviction?: string; persistent: boolean }[]; reports: number; latest: { date: string; regime?: string } | null }>('/api/config?view=picks')

export const getConsensus = () =>
  apiGet<{ tickers: { sym: string; mentions7d: number; mentionsPrior7d: number; channels: number; bulls: number; bears: number; net: number; crowded: boolean; shifted: boolean }[]; themes: { theme: string; count7d: number }[] }>('/api/config?view=consensus')

export const getVideoAnalyses = () =>
  apiGet<{ url: string; title: string; channel: string; analysis: string; at: number }[]>('/api/config?view=videos')

export const getAlertHistory = () =>
  apiGet<{ text: string; tier: string; at: number }[]>('/api/config?view=history')

export const getRunlog = () =>
  apiGet<{ at: number; events: number; sent: number; errors: string[] }[]>('/api/config?view=runlog')

export const getAiRead = () =>
  apiGet<{ text?: string; provider?: string; at?: number; unconfigured?: boolean; empty?: boolean }>('/api/ai')

export const getNews = (symbol: string) =>
  apiGet<{ items: { title: string; url: string; publishedSec: number }[] }>(`/api/market?type=news&symbol=${encodeURIComponent(symbol)}`).then(d => d.items)

export async function putConfig(cfg: AppConfig): Promise<void> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  const body = (await res.json()) as ApiEnvelope<AppConfig>
  if (!body.ok) throw new Error(body.error ?? `http-${res.status}`)
}
