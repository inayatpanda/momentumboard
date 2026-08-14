import type { AlertRule } from './alerts'
import { GATE_BOUNDS, TUNABLE_GATES, type GateOverride } from './engine/gateState'
import type { LevMap } from './engine/riskLadder'

export interface UserNote {
  id: string
  text: string
  kind: 'observation' | 'lesson' | 'hypothesis'
  ticker?: string
  at: number
}

export interface AppConfig {
  watchlist: { symbol: string; riskClass: 'normal' | 'speculative'; category?: string }[]
  rules: AlertRule[]
  ytChannels: { id: string; name: string }[]
  capital: number
  notes?: UserNote[]
  // underlying → the ISA-eligible tickers that hold it. `long2x/long3x/short2x/
  // short3x` are geared ETPs (a full-size row only); `long1x/short1x` are 1×
  // spot/inverse TRACKERS, which a row of any size may hold because they carry
  // no gearing — that is how a crypto row routes at all (an ISA cannot hold a
  // coin, but it can hold a cETN over one). Every ticker here is the owner's own
  // instrument decision; the engine never invents one. See LevMap (riskLadder).
  levMap?: LevMap
  coreSleeve?: string[] // owner-extended additions to the standing core sleeve (union over defaults, never replace)
  riskRungOverride?: 0 | 1 | 2 | 3 | null // manual risk-ladder pin; null = engine decides
  // Manual gate pins (shared/engine/gateState.ts), mirroring riskRungOverride: a
  // pinned gate ignores whatever feedback earned and refuses to move, while its
  // evidence keeps accruing and keeps being reported. Values are clamped to the
  // gate's hard bounds here, so a stored config can never widen one.
  gateOverride?: GateOverride | null
  favouriteChannels?: string[] // credibility prior 0.6 instead of 0.5
  riskAppetite?: 'moderate' | 'aggressive' // engine gates: aggressive widens the funnel (catalyst.ts). Default moderate.
  reportRecipients?: ReportRecipient[] // admin-managed extra recipients, per-edition, unioned with env REPORT_EMAIL_TO
}

// The three daily sends a recipient can be subscribed to individually.
export type ReportEdition = 'morning' | 'premarket' | 'evening'
export const REPORT_EDITIONS: ReportEdition[] = ['morning', 'premarket', 'evening']

export interface ReportRecipient {
  email: string
  editions: ReportEdition[] // empty = paused (kept on the list, sent nothing)
}

export function validateConfig(raw: unknown): AppConfig | null {
  const c = raw as AppConfig
  if (!c || !Array.isArray(c.watchlist) || !Array.isArray(c.rules) || !Array.isArray(c.ytChannels)) return null
  if (c.watchlist.length > 30) return null
  if (!c.watchlist.every(w => typeof w?.symbol === 'string' && w.symbol.length <= 12)) return null
  c.watchlist = c.watchlist.map(w => ({ ...w, category: typeof w.category === 'string' ? w.category.slice(0, 24) : undefined }))
  if (!c.rules.every(r => typeof r?.id === 'string' && typeof r?.symbol === 'string' && (r.kind === 'priceAbove' || r.kind === 'priceBelow') && typeof r.level === 'number')) return null
  const notes = Array.isArray(c.notes)
    ? c.notes
        .filter(n => typeof n?.text === 'string' && typeof n?.id === 'string')
        .slice(0, 50)
        .map(n => ({
          id: n.id,
          text: n.text.slice(0, 500),
          kind: n.kind === 'lesson' || n.kind === 'hypothesis' ? n.kind : ('observation' as const),
          ticker: typeof n.ticker === 'string' ? n.ticker.toUpperCase().slice(0, 12) : undefined,
          at: typeof n.at === 'number' ? n.at : 0,
        }))
    : undefined
  const levMap: LevMap = {}
  if (c.levMap && typeof c.levMap === 'object') {
    // 80, and the number is a TRUNCATION CLIFF, not a quota (codex 1c-R
    // finding 2): entries past it are dropped SILENTLY, and the map sits
    // around forty real routes today — at the old cap of 40, adding the three
    // crypto pairs would have discarded whichever route sorted last, with no
    // error anywhere. The bound exists only so a garbage blob cannot balloon
    // the config; it must stay far above any real book.
    for (const [sym, m] of Object.entries(c.levMap).slice(0, 80)) {
      if (!m || typeof m !== 'object') continue
      const entry: LevMap[string] = {}
      // `long1x`/`short1x` are the 1× spot/inverse trackers the crypto route
      // mints (riskLadder.LevMap). They validate exactly like the geared
      // tickets — the difference between them is the engine's, not the
      // config's — and an entry made of nothing but 1x fields is a complete,
      // valid route: dropping it here would leave the lane paper-only forever
      // with no error anywhere to say why.
      for (const k of ['long1x', 'long2x', 'long3x', 'short1x', 'short2x', 'short3x'] as const) {
        const v = (m as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.length) entry[k] = v.toUpperCase().slice(0, 12)
      }
      if (Object.keys(entry).length) levMap[sym.toUpperCase().slice(0, 12)] = entry
    }
  }
  // ABSENT (undefined) must stay undefined so a server-side merge can preserve a
  // stored pin — the phone's config mirror never sends this field. An explicit
  // null (or any present-but-invalid value) means "engine decides" → null.
  const riskRungOverride: 0 | 1 | 2 | 3 | null | undefined =
    typeof c.riskRungOverride === 'number' && Number.isInteger(c.riskRungOverride) && c.riskRungOverride >= 0 && c.riskRungOverride <= 3
      ? (c.riskRungOverride as 0 | 1 | 2 | 3)
      : c.riskRungOverride === undefined
        ? undefined
        : null
  // Same absent-vs-null contract as riskRungOverride above: ABSENT stays
  // undefined so a server-side merge preserves a stored pin, and a present
  // object is sanitised key by key — unknown gates dropped, non-finite values
  // dropped, every survivor clamped into that gate's hard bounds. An object with
  // nothing valid left in it is an explicit "engine decides" → null.
  const gateOverride: GateOverride | null | undefined = (() => {
    if (c.gateOverride === undefined) return undefined
    const raw = c.gateOverride && typeof c.gateOverride === 'object' ? (c.gateOverride as Record<string, unknown>) : null
    const out: GateOverride = {}
    for (const g of TUNABLE_GATES) {
      const v = raw?.[g]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      out[g] = Math.min(GATE_BOUNDS[g].max, Math.max(GATE_BOUNDS[g].min, v))
    }
    return Object.keys(out).length ? out : null
  })()
  const coreSleeve = Array.isArray(c.coreSleeve)
    ? c.coreSleeve
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.toUpperCase())
        .filter(s => /^[A-Z0-9.\-]{1,12}$/.test(s))
        .slice(0, 200)
    : undefined
  const favouriteChannels = Array.isArray(c.favouriteChannels)
    ? c.favouriteChannels.filter(f => typeof f === 'string').slice(0, 10).map(f => f.slice(0, 40))
    : undefined
  const riskAppetite = c.riskAppetite === 'aggressive' ? 'aggressive' : c.riskAppetite === 'moderate' ? 'moderate' : undefined
  // accepts BOTH shapes: legacy bare strings (pre-editions lists — they were
  // receiving every send, so they migrate to all three) and the current
  // {email, editions} objects. Normalised to objects on the way through.
  const reportRecipients = Array.isArray(c.reportRecipients)
    ? (() => {
        const seen = new Set<string>()
        const out: ReportRecipient[] = []
        for (const r of c.reportRecipients as unknown[]) {
          const raw = typeof r === 'string' ? { email: r, editions: undefined } : r && typeof r === 'object' ? (r as { email?: unknown; editions?: unknown }) : null
          if (!raw || typeof raw.email !== 'string') continue
          const addr = raw.email.trim().toLowerCase()
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || seen.has(addr)) continue
          seen.add(addr)
          const editions = Array.isArray(raw.editions)
            ? (raw.editions.filter(e => REPORT_EDITIONS.includes(e as ReportEdition)) as ReportEdition[])
            : [...REPORT_EDITIONS] // legacy/absent = everything, matching prior behaviour
          out.push({ email: addr, editions })
          if (out.length >= 50) break
        }
        return out
      })()
    : undefined
  return {
    watchlist: c.watchlist,
    rules: c.rules,
    ytChannels: c.ytChannels,
    capital: typeof c.capital === 'number' ? c.capital : 5000,
    notes,
    // PRESENCE, not emptiness, decides (codex 1c-R finding 3): a caller that
    // SENT a levMap keeps it even when it validated to {} — an explicit empty
    // map is "clear my routes", and collapsing it to undefined made the last
    // route uncorrectable (config-sync preserves stored on absence, so a
    // withdrawn tracker stayed executable forever). The phone mirror never
    // sends the key at all, so its syncs still preserve — the exact
    // riskRungOverride contract, one field over.
    levMap: c.levMap && typeof c.levMap === 'object' ? levMap : undefined,
    coreSleeve: coreSleeve && coreSleeve.length ? coreSleeve : undefined,
    riskRungOverride,
    gateOverride,
    favouriteChannels,
    riskAppetite,
    reportRecipients,
  }
}
