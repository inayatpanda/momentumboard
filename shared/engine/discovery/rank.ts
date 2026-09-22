// Cross-sectional ranking, hygiene floors and per-lens selection. Pure.
//
// The point of ranking is that "unusual" has no absolute definition. A 3% day is
// a yawn in a March tape and a shock in a July one; 3% on a utility is a story
// and 3% on a biotech is Tuesday. So every feature a lens leans on is scored as
// a percentile across the SAME day's universe, and the name's own history is
// folded in separately (see `unusualRatio`).

import {
  HYGIENE,
  LENS_IDS,
  LENS_SECTOR_SHARE_MAX,
  LENS_TOP_N,
  MAX_LENSES_PER_NAME,
  type DiscoveryCandidate,
  type DiscoveryRejectCode,
  type Features,
  type LensHit,
  type LensId,
  type Percentiles,
  type UniverseMember,
} from './types'

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

/** Today's move measured in the name's OWN typical days, not in percent.
 *
 * `typicalMove10` is the p80 |10-session move|; a 10-session move scales roughly
 * with √10 of a one-session move, so dividing by √10 puts the two on the same
 * footing. The floor of 1(%) stops a somnolent name (typical 10-day move of 2%)
 * from turning an ordinary 2% session into a 3× "shock".
 *
 * The goal is a scale on which GLW up 6% and a penny name up 25% can both be
 * extreme, because each is judged against what IT usually does. */
export function unusualRatio(f: Features): number | null {
  if (f.ret1 == null || f.typicalMove10 == null) return null
  const dailyTypical = Math.max(f.typicalMove10 / Math.sqrt(10), 1)
  const r = Math.abs(f.ret1) / dailyTypical
  return Number.isFinite(r) ? round4(r) : null
}

/** EVERY field ranked, and nothing else.
 *
 * A percentile costs a sort over the whole universe per run; six of the nine
 * fields this used to rank (ret1, ret5, ret20, rvol, dollarVol20, ddFrom20dHigh)
 * were read by no lens, so the run paid for them every morning and nobody ever
 * looked. The list is now exactly the set lenses.ts dereferences off `p`, and
 * rank.test.ts holds the two in agreement by reading the lens source — so a new
 * lens that reads `p.rvol` fails loudly here rather than silently reading 0.5.
 *
 * A raw feature that no lens ranks is NOT lost: it still rides on `Features`,
 * where lenses read it absolutely (RVOL ≥ 2 is about the name, not the field). */
export const PERCENTILE_FIELDS = ['rsSpy20', 'rsSpy60', 'unusual'] as const
type PercentileField = (typeof PERCENTILE_FIELDS)[number]

const rawFor = (f: Features, field: PercentileField): number | null =>
  field === 'unusual' ? unusualRatio(f) : (f[field] as number | null)

/** Percentile rank with ties averaged: (#below + #equal/2) / n, over the names
 * that HAVE the value. A name with no value sits at 0.5 — the middle of the
 * field, so a missing feature neither wins nor loses a lens on its own. */
export function percentileRanks(features: Features[]): Map<string, Percentiles> {
  const sorted: Record<string, number[]> = {}
  for (const field of PERCENTILE_FIELDS) {
    const vals: number[] = []
    for (const f of features) {
      const v = rawFor(f, field)
      if (v != null) vals.push(v)
    }
    vals.sort((a, b) => a - b)
    sorted[field] = vals
  }

  // first index with vals[i] >= x / first index with vals[i] > x
  const lowerBound = (vals: number[], x: number): number => {
    let lo = 0
    let hi = vals.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (vals[mid] < x) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const upperBound = (vals: number[], x: number): number => {
    let lo = 0
    let hi = vals.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (vals[mid] <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const out = new Map<string, Percentiles>()
  for (const f of features) {
    const p = {} as Percentiles
    for (const field of PERCENTILE_FIELDS) {
      const v = rawFor(f, field)
      const vals = sorted[field]
      if (v == null || !vals.length) {
        p[field] = 0.5
        continue
      }
      const below = lowerBound(vals, v)
      const equal = upperBound(vals, v) - below
      p[field] = round4((below + equal / 2) / vals.length)
    }
    out.set(f.sym, p)
  }
  return out
}

/** Calendar days → sessions, the cheap way: markets trade 5 of every 7 days, so
 * a 7-day gap is ~5 sessions. Good enough for a 3-session staleness limit; the
 * only error a bank holiday can introduce is well under one session. */
const SESSIONS_PER_DAY = 5 / 7
export const sessionsBetween = (fromT: number, toT: number): number => ((toT - fromT) / 86_400) * SESSIONS_PER_DAY

/** Does this name QUOTE IN PENCE?
 *
 * The currency, not the venue. Most LSE lines quote in `GBp` (Yahoo's spelling
 * for pence), but eight rows of the committed seed — CPG.L, IHG.L, BCG.L, PEY.L
 * … — quote in USD or EUR on the same exchange. Keying the pence rules on the
 * exchange divided their dollar volume by 100 and measured their $25 price
 * against a 50p floor, so every one of them was thrown out as a penny stock that
 * could not trade. Unknown currency (a dynamic member, a nomination) falls back
 * to the venue, which is right nine times in ten and is all we know. */
export const quotesInPence = (m: Pick<UniverseMember, 'exchange' | 'currency'>): boolean =>
  m.currency ? m.currency === 'GBp' : m.exchange === 'LSE'

/** Dollar (or pound) volume on the right scale.
 *
 * A pence quote makes `dollarVol20` (close × volume straight off the tape) a
 * pence×shares number; £ = pence/100 × shares. Skipping the divide would let a
 * 40p shell clear a £2M floor a hundred times over — and applying it to an
 * LSE line that quotes in dollars shrinks a real $200M tape to $2M. */
export const liquidityFloorFor = (exchange: UniverseMember['exchange']): number =>
  exchange === 'LSE' ? HYGIENE.minDollarVol20LSE : HYGIENE.minDollarVol20US
export const scaleDollarVol = (m: Pick<UniverseMember, 'exchange' | 'currency'>, dollarVol20: number): number =>
  quotesInPence(m) ? dollarVol20 / 100 : dollarVol20

/** The floors, cheapest first. `null` = the name is scannable.
 *
 * `f == null` means the tape was too short to read (computeFeatures' only null).
 * A name with NO tape at all never reaches here — that is 'no-bars', and only
 * the caller knows it. `lastSessionT` is the newest bar stamp seen on THIS
 * NAME'S OWN EXCHANGE today (discoverPure computes one per venue): the two
 * calendars diverge on every one-sided holiday, and measuring an LSE tape
 * against Wall Street's clock made a UK bank holiday look like a delisting. */
export function applyHygiene(
  member: UniverseMember,
  f: Features | null,
  lastSessionT: number,
  isEtp: (sym: string) => boolean,
): DiscoveryRejectCode | null {
  if (isEtp(member.sym)) return 'etp'
  if (f == null || f.bars < HYGIENE.minBars) return 'too-short'
  if (sessionsBetween(f.lastT, lastSessionT) > HYGIENE.maxStaleSessions) return 'stale-bars'

  // The price floor follows the QUOTE, not the venue: 50p for a pence line,
  // $2 for the LSE names that quote in dollars or euros (and for everything US).
  const minPrice = quotesInPence(member) ? HYGIENE.minPriceGBp : HYGIENE.minPriceUS
  if (!(f.close >= minPrice)) return 'price-floor'

  // A floor you cannot evidence is not a floor you passed.
  if (f.dollarVol20 == null) return 'liquidity-floor'
  if (scaleDollarVol(member, f.dollarVol20) < liquidityFloorFor(member.exchange)) return 'liquidity-floor'
  return null
}

/** At most 30% of one lens's picks from one sector, and never fewer than 1. */
const sectorCapFor = (lens: LensId): number => Math.max(1, Math.floor(LENS_TOP_N[lens] * LENS_SECTOR_SHARE_MAX))

/** WHAT THE WALK-FORWARD STUDY BUYS AT THE FRONT OF THE POOL (2026-09-22).
 *
 * The study swept eight lenses and fourteen features over ~348k name-dates and
 * found two things worth ordering a queue by, and nothing worth sizing on:
 *
 *   rs-leader   the best lens at every horizon — +1.10pp over 10 sessions,
 *               +2.55pp over 20, hit 46.5%/49.7%, positive in BOTH halves. Its
 *               honest t_NW is 1.6, short of 2, which is exactly why it is
 *               spelled here as PRIORITY rather than as conviction: the study's
 *               own verdict is "a WATCHLIST, not a sized call".
 *   compression the only feature whose IC keeps its sign across both halves AND
 *               both venues while reaching |t| ≥ 2 — IC t 3.0 at 10 sessions,
 *               5.5 at 20, top-minus-bottom decile +0.58pp/+1.00pp. The cut at
 *               0.2 is the tightest fifth of the name's own 120-session
 *               Bollinger width, comfortably inside the study's D1 bucket.
 *
 * THIS ORDERS, IT NEVER ADMITS OR REFUSES. Every candidate in `kept` already
 * entered the pool by clearing its lens's own gate and the per-lens top-N; all
 * these two numbers decide is who the downstream fetch and scoring budget reaches
 * FIRST. Nothing is dropped because it lacks them, and nothing is added because
 * it has them. The bumps are additive and can carry a priority above 1 — it is a
 * sort key, not a probability, and clamping would only manufacture ties.
 *
 * The sizes are deliberately small relative to a lens score: 0.15 moves a name
 * past a rival about 0.21 of a lens score ahead of it (the 0.7 multiplier), which
 * reorders neighbours rather than teleporting a weak leader to the top. */
export const PRIORITY_BUMP = { rsLeader: 0.15, compression: 0.1 } as const
export const COMPRESSION_PCTL_MAX = 0.2

/** Best-lens quality is 70% of the answer; independent corroboration is 30%.
 *
 * Two nominators (news AND social, say) is the most the bump ever pays: the
 * third source is usually the first two repeated, and a loud name must not be
 * able to out-rank a good one on volume of chatter alone.
 *
 * `evidence` defaults to nothing, so a caller that knows neither reading scores
 * exactly what it scored before this argument existed. */
export const priorityFor = (
  bestScore: number,
  nominatorCount: number,
  evidence: { rsLeader?: boolean; compressed?: boolean } = {},
): number =>
  round4(
    bestScore * 0.7 +
      0.3 * Math.min(1, nominatorCount / 2) +
      (evidence.rsLeader ? PRIORITY_BUMP.rsLeader : 0) +
      (evidence.compressed ? PRIORITY_BUMP.compression : 0),
  )

/**
 * Per lens: order by score (ties → symbol, so the output never depends on Map
 * insertion order), fill top-N while honouring the sector cap, then keep each
 * name's best MAX_LENSES_PER_NAME readings. Everything that fired and did not
 * survive comes back in `cut` so the trace can say "seen, ranked, just missed".
 */
export function selectCandidates(
  hits: Map<string, LensHit[]>,
  members: Map<string, UniverseMember>,
  features: Map<string, Features>,
  nominators: Map<string, string[]>,
): { candidates: DiscoveryCandidate[]; cut: Map<string, LensHit[]> } {
  const kept = new Map<string, LensHit[]>()
  const cut = new Map<string, LensHit[]>()
  const addCut = (sym: string, hit: LensHit) => {
    const list = cut.get(sym)
    if (list) list.push(hit)
    else cut.set(sym, [hit])
  }

  for (const lens of LENS_IDS) {
    const row: { sym: string; hit: LensHit }[] = []
    for (const [sym, list] of hits) {
      if (!members.has(sym) || !features.has(sym)) continue
      for (const hit of list) if (hit.lens === lens) row.push({ sym, hit })
    }
    row.sort((a, b) => b.hit.score - a.hit.score || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0))

    const cap = sectorCapFor(lens)
    const bySector = new Map<string, number>()
    let taken = 0
    for (const { sym, hit } of row) {
      if (taken >= LENS_TOP_N[lens]) {
        addCut(sym, hit)
        continue
      }
      // Unknown sector never blocks: the cap prunes redundancy, it doesn't demand coverage.
      const sector = members.get(sym)!.sector
      if (sector && (bySector.get(sector) ?? 0) >= cap) {
        addCut(sym, hit)
        continue
      }
      if (sector) bySector.set(sector, (bySector.get(sector) ?? 0) + 1)
      taken++
      const list = kept.get(sym)
      if (list) list.push(hit)
      else kept.set(sym, [hit])
    }
  }

  const candidates: DiscoveryCandidate[] = []
  for (const [sym, list] of kept) {
    const member = members.get(sym)!
    const f = features.get(sym)!
    const ordered = [...list].sort((a, b) => b.score - a.score || LENS_IDS.indexOf(a.lens) - LENS_IDS.indexOf(b.lens))
    for (const overflow of ordered.slice(MAX_LENSES_PER_NAME)) addCut(sym, overflow)
    const lenses = ordered.slice(0, MAX_LENSES_PER_NAME)
    const noms = nominators.get(sym) ?? []
    candidates.push({
      sym,
      exchange: member.exchange,
      capBand: member.capBand,
      sector: member.sector,
      // carried verbatim so a consumer can ask WHICH index conferred the band
      index: member.index ? [...member.index] : undefined,
      lenses,
      features: f,
      // ANY kept reading, not just the best one: a name whose top lens is
      // `unusual` and whose second is `rs-leader` IS a leader, and reading only
      // `lenses[0]` would have said otherwise on the strength of a sort.
      priority: priorityFor(lenses[0].score, noms.length, {
        rsLeader: lenses.some(l => l.lens === 'rs-leader'),
        compressed: f.bbWidthPctl120 != null && f.bbWidthPctl120 <= COMPRESSION_PCTL_MAX,
      }),
      nominators: noms,
    })
  }
  candidates.sort((a, b) => b.priority - a.priority || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0))
  for (const [, list] of cut) list.sort((a, b) => b.score - a.score || LENS_IDS.indexOf(a.lens) - LENS_IDS.indexOf(b.lens))
  return { candidates, cut }
}
