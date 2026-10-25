import Dexie, { type Table } from 'dexie'
import type { Trade } from '../../shared/journal'
import { deviceDatabaseName } from '../../shared/deviceAccess'

export interface WatchItem {
  symbol: string
  addedAt: number
  riskClass: 'normal' | 'speculative'
  category?: string
}

export interface NoteItem {
  id: string
  text: string
  kind: 'observation' | 'lesson' | 'hypothesis'
  ticker?: string
  at: number
  aiTake?: string
}

export interface RuleItem {
  id: string
  symbol: string
  kind: 'priceAbove' | 'priceBelow'
  level: number
  createdAt: number
}

/** One cached record in the v2 local-first layer (plan Task 8): a view slice,
 * a candle series, or a quote batch, stamped with when it was fetched. */
export interface SliceRow {
  key: string
  data: unknown
  fetchedAt: number
}

class MBDatabase extends Dexie {
  watchlist!: Table<WatchItem, string>
  settings!: Table<{ key: string; value: string }, string>
  rules!: Table<RuleItem, string>
  trades!: Table<Trade, string>
  notes!: Table<NoteItem, string>
  slices!: Table<SliceRow, string>
  candles!: Table<SliceRow, string>
  quotes!: Table<SliceRow, string>
  constructor() {
    // New free identities never inherit an old admin/reader's local notes,
    // positions or API key. Legacy data is preserved in its original database.
    super(deviceDatabaseName(typeof localStorage==='undefined'?null:localStorage.getItem('mb-token')))
    this.version(1).stores({ watchlist: 'symbol', settings: 'key' })
    this.version(2).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol' })
    this.version(3).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol', trades: 'id, symbol, openedAt' })
    this.version(4).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol', trades: 'id, symbol, openedAt', notes: 'id, at' })
    // v5 (PWA rebuild): the local-first cache tables. Every v4 table is
    // re-declared IDENTICALLY — installed users' journals/watchlists survive
    // (CX-5; the upgrade test drives this against a real populated v4 DB).
    this.version(5).stores({
      watchlist: 'symbol',
      settings: 'key',
      rules: 'id, symbol',
      trades: 'id, symbol, openedAt',
      notes: 'id, at',
      slices: '&key, fetchedAt',
      candles: '&key, fetchedAt',
      quotes: '&key, fetchedAt',
    })
  }
}

export async function getCapital(): Promise<number> {
  const row = await db.settings.get('capital')
  const v = row ? parseFloat(row.value) : NaN
  return Number.isFinite(v) && v > 0 ? v : 5000
}

export async function getChannels(): Promise<{ id: string; name: string }[]> {
  const row = await db.settings.get('ytChannels')
  if (!row) {
    const { DEFAULT_CHANNELS } = await import('../../shared/channels')
    return DEFAULT_CHANNELS
  }
  try {
    return JSON.parse(row.value)
  } catch {
    return []
  }
}

export const db = new MBDatabase()
