import Dexie, { type Table } from 'dexie'

export interface WatchItem {
  symbol: string
  addedAt: number
  riskClass: 'normal' | 'speculative'
}

class MBDatabase extends Dexie {
  watchlist!: Table<WatchItem, string>
  settings!: Table<{ key: string; value: string }, string>
  constructor() {
    super('momentumboard')
    this.version(1).stores({ watchlist: 'symbol', settings: 'key' })
  }
}

export const db = new MBDatabase()
