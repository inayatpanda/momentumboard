import { describe, expect, it } from 'vitest'
import { engineLevelLines, entryQualityRole, stageMarkerSpec, stageShortLabel } from './engineLevels'
import type { TechnicalRead } from '../../shared/technicals'

describe('engineLevelLines', () => {
  it('maps a long call to ink entry, red stop (below), green target (above)', () => {
    const lines = engineLevelLines({ side: 'long', entry: 100, stop: 92, target: 118 })
    expect(lines).toEqual([
      { price: 100, title: 'engine entry', role: 'ink' },
      { price: 92, title: 'engine stop', role: 'down' },
      { price: 118, title: 'engine target', role: 'up' },
    ])
    // side is encoded in the values: a long's stop sits below entry, target above
    const [entry, stop, target] = lines
    expect(stop.price).toBeLessThan(entry.price)
    expect(target.price).toBeGreaterThan(entry.price)
  })

  it('keeps roles fixed for a short call — values already invert (stop above, target below)', () => {
    const lines = engineLevelLines({ side: 'short', entry: 162, stop: 178.2, target: 145.8 })
    const [entry, stop, target] = lines
    expect(stop.role).toBe('down')
    expect(target.role).toBe('up')
    // no re-orientation: we trust the side-encoded numbers
    expect(stop.price).toBeGreaterThan(entry.price)
    expect(target.price).toBeLessThan(entry.price)
  })
})

describe('entryQualityRole', () => {
  it('colours early green, chase red, and everything else ink', () => {
    expect(entryQualityRole('early')).toBe('up')
    expect(entryQualityRole('chase')).toBe('down')
    expect(entryQualityRole('neutral')).toBe('ink')
    expect(entryQualityRole('wait')).toBe('ink')
  })
})

describe('stageShortLabel', () => {
  it('shortens compound stage names for the tape marker', () => {
    expect(stageShortLabel('early-reversal')).toBe('reversal')
    expect(stageShortLabel('falling-knife')).toBe('knife')
    expect(stageShortLabel('pullback')).toBe('pullback')
  })
})

describe('stageMarkerSpec', () => {
  it('builds an above-bar marker coloured by entry quality with the short label', () => {
    const read = { stage: 'pullback', entryQuality: 'early' } as TechnicalRead
    expect(stageMarkerSpec(read)).toEqual({ position: 'aboveBar', role: 'up', text: 'pullback' })
  })

  it('marks a chase (extended) read red', () => {
    const read = { stage: 'extended', entryQuality: 'chase' } as TechnicalRead
    expect(stageMarkerSpec(read)).toMatchObject({ role: 'down', text: 'extended' })
  })
})
