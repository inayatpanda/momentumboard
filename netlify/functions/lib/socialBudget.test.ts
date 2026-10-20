import { describe, expect, it } from 'vitest'
import { memoryStore } from './store'
import { reserveSocialBudget } from './socialBudget'

describe('social attempt budgets', () => {
  it('caps free video attempts independently from legacy Gemini failures and resets each UTC day', async () => {
    const store = memoryStore()
    const now = Date.parse('2026-10-20T10:00:00Z') / 1000
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'gemini-extract', now)).toBe(false)
    expect(await reserveSocialBudget(store, 'github-native-free', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'github-native-free', now)).toBe(true)
    expect(await reserveSocialBudget(store, 'github-native-free', now)).toBe(false)
    expect(await reserveSocialBudget(store, 'github-native-free', now + 86400)).toBe(true)
  })
})
