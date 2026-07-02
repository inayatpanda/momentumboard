export interface Candle {
  t: number // unix seconds, daily bar
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface Quote {
  symbol: string
  name?: string
  price: number
  prevClose: number
  changePct: number
  currency: string // 'USD' | 'GBP' | 'GBp' | ...
  todayVolume: number | null
  asOf: number // unix seconds
  source: 'finnhub' | 'yahoo'
}

export type RegimeColor = 'green' | 'amber' | 'red'

export type SetupKind =
  | 'basing'
  | 'divergence'
  | 'reclaim'
  | 'pullbackZone'
  | 'breakoutWatch'
  | 'breakoutLive'
  | 'overextended'
  | 'fallingKnife'

export interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
}
