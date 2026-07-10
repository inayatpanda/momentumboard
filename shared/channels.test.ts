import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNELS } from './channels'

describe('DEFAULT_CHANNELS', () => {
  it('tracks Gareth Holloway with a real resolved channel id', () => {
    const gareth = DEFAULT_CHANNELS.find(c => c.name === 'Gareth Holloway')
    expect(gareth).toBeDefined()
    // resolved from the channel page source (externalId), not invented
    expect(gareth!.id).toBe('UCOg_HWm16bs0WTYTg8yFOtA')
  })

  it('list shape is intact: every entry is a { id, name } with a stable UC channel id', () => {
    expect(Array.isArray(DEFAULT_CHANNELS)).toBe(true)
    expect(DEFAULT_CHANNELS.length).toBeGreaterThanOrEqual(7)
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
