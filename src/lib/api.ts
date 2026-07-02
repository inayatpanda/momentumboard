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
