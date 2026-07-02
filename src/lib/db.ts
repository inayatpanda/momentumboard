import Dexie, { type Table } from 'dexie'

export interface WatchItem {
  symbol: string
  addedAt: number
  riskClass: 'normal' | 'speculative'
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
  constructor() {
    super('momentumboard')
    this.version(1).stores({ watchlist: 'symbol', settings: 'key' })
    this.version(2).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol' })
  }
}

export const db = new MBDatabase()
