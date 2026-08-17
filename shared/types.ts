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
  changePct: number | null
  currency: string // 'USD' | 'GBP' | 'GBp' | ...
  todayVolume: number | null
  asOf: number // unix seconds
  source: 'finnhub' | 'yahoo'
  /** Present and true ONLY on a last-known-good row: the upstream refused this
   * symbol twice, so the board served the price it last had rather than a dash.
   * `asOf` is the original stamp — the age of the number, not of the answer.
   * Absent means the row is live. Optional so every existing producer and the
   * client's own copy of this type stay compatible. */
  stale?: boolean
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
