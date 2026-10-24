import { PATTERN_ASSETS, type MarketPatternsSnapshot, type PatternPeriod } from '../../shared/engine/marketPatterns'
export interface PatternTape { symbol: string; rows: { date: string; close: number }[] }
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
export function parsePatternTape(body: any, symbol: string, now: number): PatternTape {
  const r = body?.chart?.result?.[0], adjusted = r?.indicators?.adjclose?.[0]?.adjclose
  if (r?.meta?.symbol !== symbol || !Array.isArray(r.timestamp) || !Array.isArray(adjusted)) throw new Error(`${symbol}: adjusted history missing`)
  const rows: PatternTape['rows'] = []
  for (let i = 0; i < r.timestamp.length; i++) {
    if (!Number.isFinite(r.timestamp[i])) throw new Error(`${symbol}: invalid date`)
    const date = iso(r.timestamp[i])
    // Exclude today's possibly incomplete bar, including when run during US hours.
    if (date >= iso(now)) continue
    const close = adjusted[i]
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) throw new Error(`${symbol}: invalid adjusted close`)
    if (rows.length && rows.at(-1)!.date >= date) throw new Error(`${symbol}: unordered or duplicate date`)
    rows.push({ date, close })
  }
  return { symbol, rows }
}
export function correlation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null
  const am = a.reduce((s, x) => s + x, 0) / a.length, bm = b.reduce((s, x) => s + x, 0) / b.length
  let cross = 0, av = 0, bv = 0
  a.forEach((v, i) => { cross += (v - am) * (b[i] - bm); av += (v - am) ** 2; bv += (b[i] - bm) ** 2 })
  return av > 0 && bv > 0 ? Math.max(-1, Math.min(1, cross / Math.sqrt(av * bv))) : null
}
export function buildMarketPatterns(tapes: PatternTape[], now: number, digest: string): MarketPatternsSnapshot {
  const year = new Date(now * 1000).getUTCFullYear(), first = `${year - 20}-01-01`
  const ordered = PATTERN_ASSETS.map(a => {
    const matches = tapes.filter(t => t.symbol === a.symbol)
    if (matches.length !== 1) throw new Error(`Missing or duplicate asset ${a.symbol}`)
    const rows = matches[0].rows.filter(r => r.date >= first && r.date < iso(now))
    if (rows.some((r, i) => !Number.isFinite(r.close) || r.close <= 0 || (i > 0 && rows[i - 1].date >= r.date))) throw new Error('Invalid history')
    return new Map(rows.map(r => [r.date, r.close]))
  })
  const start = ordered.map(m => [...m.keys()][0]).sort().at(-1)!
  const dates = [...ordered[0].keys()].filter(d => ordered.every(m => m.has(d)))
  if (dates.length < 4500 || Date.parse(iso(now)) - Date.parse(dates.at(-1)!) > 7 * 86400000) throw new Error('Insufficient or stale cross-market history')
  // A missing series must not turn a daily return into a multi-day return unnoticed.
  const dateSet = new Set(dates)
  for (const m of ordered) if ([...m.keys()].filter(d => d >= start).some(d => !dateSet.has(d))) throw new Error('Market dates do not align; retain previous snapshot')
  const prices = ordered.map(m => dates.map(d => m.get(d)!)), end = dates.length - 1
  const ret = (asset: number, from: number, to: number) => (prices[asset][to] / prices[asset][from] - 1) * 100
  const daily = prices.map(ps => ps.slice(1).map((p, i) => p / ps[i] - 1))
  const pairs: MarketPatternsSnapshot['pairs'] = []
  for (let a = 0; a < prices.length; a++) for (let b = a + 1; b < prices.length; b++) pairs.push({ a: PATTERN_ASSETS[a].symbol, b: PATTERN_ASSETS[b].symbol,
    recent: correlation(daily[a].slice(-252), daily[b].slice(-252)), historical: correlation(daily[a], daily[b]), recentN: Math.min(252, daily[a].length), historicalN: daily[a].length })
  const period = (i: number): PatternPeriod => ({ date: dates[i], endDate: dates[i + 21], returns: prices.map((_, a) => ret(a, i, i + 21)) })
  const seasonal: PatternPeriod[] = [], asOf = dates[end], asOfYear = Number(asOf.slice(0, 4))
  for (let y = asOfYear - 20; y < asOfYear; y++) {
    const anchor = `${y}${asOf.slice(4)}`
    const i = dates.findIndex(d => d >= anchor)
    // Never substitute a later year or skip a missing season silently.
    if (i >= 0 && Date.parse(dates[i]) - Date.parse(anchor) <= 4 * 86400000 && i + 21 <= end) seasonal.push(period(i))
  }
  // Compare trailing month moves relative to each asset's own trailing-year
  // daily volatility. Every candidate feature uses only prices known that day.
  const features = (i: number) => prices.map((_, a) => {
    const ds = daily[a].slice(i - 252, i), mean = ds.reduce((s, x) => s + x, 0) / ds.length
    const vol = Math.sqrt(ds.reduce((s, x) => s + (x - mean) ** 2, 0) / ds.length)
    return ret(a, i - 21, i) / 100 / Math.max(vol * Math.sqrt(21), .0001)
  })
  const target = features(end), candidates: { i: number; distance: number }[] = []
  for (let i = 252; i + 63 < end; i++) {
    const f = features(i)
    candidates.push({ i, distance: Math.sqrt(f.reduce((s, v, a) => s + (v - target[a]) ** 2, 0) / f.length) })
  }
  candidates.sort((a, b) => a.distance - b.distance || a.i - b.i)
  const selected: typeof candidates = []
  for (const c of candidates) {
    if (selected.every(p => Math.abs(p.i - c.i) >= 126)) selected.push(c)
    if (selected.length === 5) break
  }
  return { version: 1, generatedAt: now, dataFrom: dates[0], dataThrough: asOf, observations: dates.length, digest,
    current: PATTERN_ASSETS.map((a, i) => ({ symbol: a.symbol, monthPct: ret(i, end - 21, end), quarterPct: ret(i, end - 63, end) })), pairs, seasonal,
    similar: selected.map(c => ({ ...period(c.i), distance: c.distance, precedingReturns: prices.map((_, a) => ret(a, c.i - 21, c.i)) })) }
}
