import { describe, it, expect } from 'vitest'
import { claimScheduleSlot } from './schedule'

function fakeStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    read: async <T>(k: string) => (data.has(k) ? (data.get(k) as T) : null),
    write: async (k: string, v: unknown) => void data.set(k, v),
    _data: data,
  }
}

describe('claimScheduleSlot', () => {
  it('admin always bypasses the window', async () => {
    const store = fakeStore({ 'sched-slot:x': 1000 })
    expect(await claimScheduleSlot('x', 3600, true, store, 1001)).toBe(true)
  })

  it('first run in a window is allowed and records the slot', async () => {
    const store = fakeStore()
    expect(await claimScheduleSlot('x', 3600, false, store, 5000)).toBe(true)
    expect(store._data.get('sched-slot:x')).toBe(5000)
  })

  it('a second run inside the window is throttled', async () => {
    const store = fakeStore({ 'sched-slot:x': 5000 })
    expect(await claimScheduleSlot('x', 3600, false, store, 5000 + 3599)).toBe(false)
  })

  it('a run after the window elapses is allowed again', async () => {
    const store = fakeStore({ 'sched-slot:x': 5000 })
    expect(await claimScheduleSlot('x', 3600, false, store, 5000 + 3600)).toBe(true)
  })

  it('the legitimate 5-minute cron cadence passes a 4-minute window', async () => {
    const store = fakeStore({ 'sched-slot:alert-check': 0 })
    expect(await claimScheduleSlot('alert-check', 240, false, store, 300)).toBe(true) // 5 min later
  })
})
