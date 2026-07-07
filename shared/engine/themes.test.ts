import { describe, expect, it } from 'vitest'
import { primaryThemeOf, THEMES, themeCandidates, themeHeat, themesOf } from './themes'

describe('themesOf', () => {
  it('tags members and leaves unthemed symbols empty', () => {
    expect(themesOf('NVDA')).toContain('chips')
    expect(themesOf('AVAV')).toEqual(['drones'])
    expect(themesOf('smci')).toEqual(['datacentre']) // case-insensitive
    expect(themesOf('KO')).toEqual([])
    expect(primaryThemeOf('OKLO')).toBe('energy')
    expect(primaryThemeOf('KO')).toBeNull()
  })
})

describe('themeHeat', () => {
  it('counts keyword hits per title and sorts hottest first', () => {
    const heat = themeHeat([
      'Nvidia GPU demand crushes semiconductor supply',
      'New chip fabs planned as foundry race heats up',
      'Drone startup wins army contract',
    ])
    expect(heat[0].key).toBe('chips')
    expect(heat[0].hits).toBeGreaterThanOrEqual(3)
    expect(heat.find(h => h.key === 'drones')!.hits).toBe(1)
    expect(heat.find(h => h.key === 'robotics')!.hits).toBe(0)
  })
  it('quiet tape → all zeros, declaration order preserved (deterministic)', () => {
    const heat = themeHeat(['Fed holds rates steady'])
    expect(heat.map(h => h.hits)).toEqual([0, 0, 0, 0, 0])
    expect(heat.map(h => h.key)).toEqual(THEMES.map(t => t.key))
  })
})

describe('themeCandidates', () => {
  it('hottest theme supplies members first; caps per theme and in total; dedupes double-hatted names', () => {
    const cands = themeCandidates(['uranium miners rally as nuclear reactor orders surge'], 8, 24)
    expect(cands.length).toBeLessThanOrEqual(24)
    expect(cands[0].theme).toBe('energy')
    expect(cands.filter(c => c.theme === 'energy')).toHaveLength(8)
    const syms = cands.map(c => c.sym)
    expect(new Set(syms).size).toBe(syms.length) // no duplicates
  })
  it('quiet day still scans every theme a little', () => {
    const cands = themeCandidates([], 4, 24)
    for (const t of THEMES) expect(cands.some(c => c.theme === t.key)).toBe(true)
  })
})
