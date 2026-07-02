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
