import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNELS } from './channels'

describe('DEFAULT_CHANNELS', () => {
  it('tracks Gareth Holloway with a real resolved channel id', () => {
    const gareth = DEFAULT_CHANNELS.find(c => c.name === 'Gareth Holloway')
    expect(gareth).toBeDefined()
    // resolved from the channel page source (externalId), not invented
    expect(gareth!.id).toBe('UCOg_HWm16bs0WTYTg8yFOtA')
  })

  it('tracks Grandmaster Obi with a real resolved channel id', () => {
    const obi = DEFAULT_CHANNELS.find(c => c.name === 'Grandmaster Obi')
    expect(obi).toBeDefined()
    // resolved from the channel page source (canonical link + og:url), not invented
    expect(obi!.id).toBe('UCddkjtql4LIVLct3tD4-3SQ')
  })

  it('list shape is intact: every entry is a { id, name } with a stable UC channel id', () => {
    expect(Array.isArray(DEFAULT_CHANNELS)).toBe(true)
    expect(DEFAULT_CHANNELS.length).toBeGreaterThanOrEqual(8)
    for (const c of DEFAULT_CHANNELS) {
      expect(typeof c.name).toBe('string')
      expect(c.name.length).toBeGreaterThan(0)
      // ids are stable channel IDs (UC + 22 chars), never handles
      expect(c.id).toMatch(/^UC[A-Za-z0-9_-]{22}$/)
    }
    // no duplicate ids or names
    expect(new Set(DEFAULT_CHANNELS.map(c => c.id)).size).toBe(DEFAULT_CHANNELS.length)
    expect(new Set(DEFAULT_CHANNELS.map(c => c.name)).size).toBe(DEFAULT_CHANNELS.length)
  })
})

describe('withDefaults', () => {
  it('unions stored channels with code defaults, deduped by id; user-added channels survive', async () => {
    const { withDefaults, DEFAULT_CHANNELS } = await import('./channels')
    const stored = [
      { id: 'UCNttUtm9vloDjo-a2jqkoNQ', name: 'Stocks with Josh' }, // default, already stored
      { id: 'UCcustom00000000000000000', name: 'My Custom Channel' }, // user-added
    ]
    const merged = withDefaults(stored)
    expect(merged.some(c => c.name === 'My Custom Channel')).toBe(true) // user channel kept
    expect(merged.some(c => c.name === 'Grandmaster Obi')).toBe(true) // missing default joined
    expect(merged.some(c => c.name === 'Gareth Holloway')).toBe(true)
    expect(merged.filter(c => c.id === 'UCNttUtm9vloDjo-a2jqkoNQ')).toHaveLength(1) // no dupes
    expect(merged).toHaveLength(stored.length + DEFAULT_CHANNELS.length - 1)
    expect(withDefaults(undefined)).toHaveLength(DEFAULT_CHANNELS.length) // empty config = defaults
  })
})
