import type { Quote } from '../../../shared/types'

export async function fetchFinnhubQuote(symbol: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<Quote> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`finnhub-http-${res.status}`)
  const j = (await res.json()) as { c: number; pc: number; t: number }
  if (!j || typeof j.c !== 'number') throw new Error('finnhub-shape')
  // Closed market (weekend/holiday) can come back as c=0 — fall back to the
  // previous close so rows show Friday's price instead of a dash.
  const live = j.c !== 0
  const price = live ? j.c : j.pc
  if (!price) throw new Error('finnhub-shape')
  return {
    symbol,
    price,
    prevClose: j.pc,
    changePct: live && j.pc ? ((j.c - j.pc) / j.pc) * 100 : 0,
    currency: 'USD',
    todayVolume: null,
    asOf: j.t,
    source: 'finnhub',
  }
}
