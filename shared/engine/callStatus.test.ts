import { describe, it, expect } from 'vitest'
import { callStatus } from './callStatus'

const long = { side: 'long' as const, entry: 12.0, stop: 11.0, target: 14.0 } // risk = 1.00
const short = { side: 'short' as const, entry: 12.0, stop: 13.0, target: 10.0 }

describe('callStatus', () => {
  it('a long that has barely moved is still live, and reads its distances from HERE', () => {
    const s = callStatus(long, 12.2)!
    expect(s.state).toBe('live')
    expect(s.pctFromEntry).toBeCloseTo(1.67, 1) // +1.7% your way
    expect(s.pctToStop).toBeCloseTo(9.84, 1) // stop is ~10% below the CURRENT price
    expect(s.pctToTarget).toBeCloseTo(14.75, 1)
    expect(s.r).toBeCloseTo(0.2, 2)
  })

  it('flags a long that has already run — half the original risk banked is chasing', () => {
    expect(callStatus(long, 12.5)!.state).toBe('extended') // +0.50R
    expect(callStatus(long, 12.49)!.state).toBe('live')
  })

  it('calls a breached stop invalidated, not a live setup', () => {
    const s = callStatus(long, 10.9)!
    expect(s.state).toBe('through-stop')
    expect(s.pctToStop).toBeLessThan(0)
    expect(s.pctFromEntry).toBeLessThan(0)
  })

  it('reports a long that reached its target', () => {
    expect(callStatus(long, 14.0)!.state).toBe('at-target')
    expect(callStatus(long, 15.0)!.state).toBe('at-target')
  })

  // A short moving DOWN is moving your way — every sign flips.
  it('reads a short in the trade\'s own direction', () => {
    const good = callStatus(short, 11.4)!
    expect(good.pctFromEntry).toBeCloseTo(5, 1) // fell 5% = +5% for a short
    expect(good.r).toBeCloseTo(0.6, 2)
    expect(good.state).toBe('extended')
    const bad = callStatus(short, 13.1)!
    expect(bad.state).toBe('through-stop') // a short's stop is ABOVE
    expect(bad.pctFromEntry).toBeLessThan(0)
    expect(callStatus(short, 10.0)!.state).toBe('at-target')
  })

  it('refuses to invent a status from a missing or nonsense price', () => {
    expect(callStatus(long, 0)).toBeNull()
    expect(callStatus(long, Number.NaN)).toBeNull()
    expect(callStatus({ ...long, entry: 0 }, 12)).toBeNull()
  })

  it('survives a zero-width risk without dividing by it', () => {
    const s = callStatus({ ...long, stop: 12.0 }, 12.5)!
    expect(s.r).toBe(0)
    expect(s.state).toBe('live')
  })
})
