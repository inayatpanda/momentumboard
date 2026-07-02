import Dexie, { type Table } from 'dexie'
import type { Trade } from '../../shared/journal'

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

class MBDatabase extends Dexie {
  watchlist!: Table<WatchItem, string>
  settings!: Table<{ key: string; value: string }, string>
  rules!: Table<RuleItem, string>
  trades!: Table<Trade, string>
  notes!: Table<NoteItem, string>
  constructor() {
    super('momentumboard')
    this.version(1).stores({ watchlist: 'symbol', settings: 'key' })
    this.version(2).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol' })
    this.version(3).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol', trades: 'id, symbol, openedAt' })
    this.version(4).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol', trades: 'id, symbol, openedAt', notes: 'id, at' })
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
