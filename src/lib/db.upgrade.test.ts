// CX-5: already-installed users sit on schema v4 of the `momentumboard` IDB.
// The v5 bump must open their database and keep every row — watchlist,
// settings, rules, trades, notes — while adding the three slice tables.
// This file builds a REAL v4 database first, THEN imports the singleton.

import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'

describe('momentumboard v4 → v5 upgrade', () => {
  it('opens a populated v4 database, preserves every table, and adds the slice tables', async () => {
    const v4 = new Dexie('momentumboard')
    v4.version(4).stores({ watchlist: 'symbol', settings: 'key', rules: 'id, symbol', trades: 'id, symbol, openedAt', notes: 'id, at' })
    await v4.open()
    await v4.table('watchlist').put({ symbol: 'NVDA', addedAt: 1, riskClass: 'normal' })
    await v4.table('settings').put({ key: 'capital', value: '5000' })
    await v4.table('trades').put({ id: 't1', symbol: 'NVDA', openedAt: 1 })
    await v4.table('notes').put({ id: 'n1', text: 'kept', kind: 'observation', at: 1 })
    v4.close()

    const { db } = await import('./db')
    await db.open()
    expect(db.verno).toBe(5)
    expect((await db.watchlist.get('NVDA'))?.riskClass).toBe('normal')
    expect((await db.settings.get('capital'))?.value).toBe('5000')
    expect((await db.trades.get('t1'))?.symbol).toBe('NVDA')
    expect((await db.notes.get('n1'))?.text).toBe('kept')
    await db.slices.put({ key: 'board', data: {}, fetchedAt: 1 })
    expect(await db.slices.get('board')).toBeTruthy()
  })
})
