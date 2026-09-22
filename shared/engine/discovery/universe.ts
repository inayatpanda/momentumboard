// Who the engine is allowed to look at today. Pure: rows in, a membership out.
//
// Three layers, in this order, because the order IS the precedence: the
// committed index seed (never expires, never stored), then dynamic members that
// earned their place recently enough, then today's nominators — which both add
// names and refresh the dynamic layer's clock.

import { isCryptoSymbol } from '../../symbols'
import {
  DYNAMIC_UNIVERSE_MAX,
  DYNAMIC_UNIVERSE_TTL_SESSIONS,
  type CapBand,
  type DynamicUniverseState,
  type Exchange,
  type UniverseMember,
} from './types'
import type { UniverseSeedRow } from './universeSeed'

export type { UniverseSeedRow }

/** One name a nominator put forward today. `origin` names the nominator
 * ('screener:gainers', 'social', 'watchlist'); it is stored verbatim when it
 * already carries a `nom:`/`seed:` prefix and prefixed with `nom:` otherwise,
 * so a caller can be explicit without the prefix ending up doubled. */
export interface UniverseNomination {
  sym: string
  origin: string
  capBand?: CapBand | null
  sector?: string | null
  exchange?: Exchange
}

const originOf = (raw: string): string => (raw.startsWith('nom:') || raw.startsWith('seed:') ? raw : `nom:${raw}`)

/** `.L` is the only non-US suffix the universe carries; everything else is US.
 * An explicit `exchange` on the nomination always wins. */
export const exchangeForNomination = (sym: string, given?: Exchange): Exchange =>
  given ?? (sym.toUpperCase().endsWith('.L') ? 'LSE' : 'US')

/** TTL in SESSIONS from two ISO dates, the cheap way: 5 sessions per 7 calendar
 * days. 60 sessions ≈ 84 days. The approximation can be a session or two out
 * across a holiday-heavy stretch, which is irrelevant to a quarter-long TTL and
 * saves carrying a trading calendar into a pure module. */
export const sessionsSince = (fromIso: string, toIso: string): number => {
  const days = (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000
  return Number.isFinite(days) ? (days * 5) / 7 : 0
}

const pushOrigin = (member: UniverseMember, origin: string) => {
  if (!member.origins.includes(origin)) member.origins.push(origin)
}

/**
 * Build today's membership plus the dynamic state to persist.
 *
 * Crypto is dropped silently at every layer — the crypto lane owns those names
 * and a discovery trace row saying "rejected: crypto" 30 times a day is noise
 * about a decision taken elsewhere.
 */
export function buildUniverse(
  seed: UniverseSeedRow[],
  dynamic: DynamicUniverseState | null,
  nominations: UniverseNomination[],
  today: string,
): { members: Map<string, UniverseMember>; nextDynamic: DynamicUniverseState; nominators: Map<string, string[]> } {
  const members = new Map<string, UniverseMember>()
  const seedSyms = new Set<string>()

  // 1. Seed. `lastSeen` is today because index membership does not decay; the
  //    field exists for the dynamic layer's TTL and seed rows never face it.
  for (const row of seed) {
    if (isCryptoSymbol(row.sym) || members.has(row.sym)) continue
    seedSyms.add(row.sym)
    members.set(row.sym, {
      sym: row.sym,
      exchange: row.exchange,
      capBand: row.capBand,
      sector: row.sector,
      // Both carried from the row rather than re-derived: the seed knows which
      // index listed the name and what Yahoo said it quotes in, and both are
      // facts a downstream gate would otherwise have to guess from the suffix.
      index: [...row.index],
      currency: row.currency ?? null,
      origins: row.index.map(ix => `seed:${ix}`),
      lastSeen: today,
    })
  }

  // 2. Dynamic, minus the expired. A stored row that has since joined an index
  //    merges its origins into the seed member rather than shadowing it.
  const surviving = new Map<string, DynamicUniverseState['members'][string]>()
  for (const sym of Object.keys(dynamic?.members ?? {}).sort()) {
    const entry = dynamic!.members[sym]
    if (isCryptoSymbol(sym)) continue
    if (sessionsSince(entry.lastSeen, today) > DYNAMIC_UNIVERSE_TTL_SESSIONS) continue
    const existing = members.get(sym)
    if (existing) {
      for (const o of entry.origins) pushOrigin(existing, o)
      continue // seed names are never stored in dynamic
    }
    surviving.set(sym, { ...entry, origins: [...entry.origins] })
    members.set(sym, {
      sym,
      exchange: entry.exchange,
      capBand: entry.capBand,
      sector: entry.sector,
      origins: [...entry.origins],
      lastSeen: entry.lastSeen,
    })
  }

  // 3. Today's nominations: add or refresh, and stamp the dynamic clock.
  const nominators = new Map<string, string[]>()
  for (const nom of nominations) {
    const sym = nom.sym
    if (!sym || isCryptoSymbol(sym)) continue
    const origin = originOf(nom.origin)
    const named = nominators.get(sym)
    if (named) {
      if (!named.includes(origin)) named.push(origin)
    } else {
      nominators.set(sym, [origin])
    }

    const exchange = exchangeForNomination(sym, nom.exchange)
    const existing = members.get(sym)
    if (existing) {
      pushOrigin(existing, origin)
      existing.lastSeen = today
      // A nomination fills a blank, never overwrites what the seed already knows.
      if (existing.capBand == null && nom.capBand != null) existing.capBand = nom.capBand
      if (existing.sector == null && nom.sector != null) existing.sector = nom.sector
    } else {
      members.set(sym, {
        sym,
        exchange,
        capBand: nom.capBand ?? null,
        sector: nom.sector ?? null,
        origins: [origin],
        lastSeen: today,
      })
    }

    if (seedSyms.has(sym)) continue
    const stored = surviving.get(sym)
    if (stored) {
      if (!stored.origins.includes(origin)) stored.origins.push(origin)
      stored.lastSeen = today
      if (stored.capBand == null && nom.capBand != null) stored.capBand = nom.capBand
      if (stored.sector == null && nom.sector != null) stored.sector = nom.sector
    } else {
      surviving.set(sym, {
        origins: [origin],
        joined: today,
        lastSeen: today,
        capBand: nom.capBand ?? null,
        sector: nom.sector ?? null,
        exchange,
      })
    }
  }

  // Cap: oldest `lastSeen` goes first, which protects everything nominated today
  // by construction. Ties break on symbol so two runs evict the same name.
  let keys = [...surviving.keys()]
  if (keys.length > DYNAMIC_UNIVERSE_MAX) {
    const byAge = [...keys].sort((a, b) => {
      const d = Date.parse(surviving.get(a)!.lastSeen) - Date.parse(surviving.get(b)!.lastSeen)
      return d || (a < b ? -1 : a > b ? 1 : 0)
    })
    for (const sym of byAge.slice(0, keys.length - DYNAMIC_UNIVERSE_MAX)) surviving.delete(sym)
    keys = [...surviving.keys()]
  }

  const nextDynamic: DynamicUniverseState = { version: 1, members: {} }
  for (const sym of keys.sort()) nextDynamic.members[sym] = surviving.get(sym)!

  return { members, nextDynamic, nominators }
}
