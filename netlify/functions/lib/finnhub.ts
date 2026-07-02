import type { Quote } from '../../../shared/types'

export async function fetchFinnhubQuote(symbol: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<Quote> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`finnhub-http-${res.status}`)
  const j = (await res.json()) as { c: number; pc: number; t: number }
  if (!j || typeof j.c !== 'number' || j.c === 0) throw new Error('finnhub-shape')
  return {
    symbol,
    price: j.c,
    prevClose: j.pc,
    changePct: j.pc ? ((j.c - j.pc) / j.pc) * 100 : 0,
    currency: 'USD',
    todayVolume: null,
    asOf: j.t,
    source: 'finnhub',
  }
}
