# Stage 1: Seeing + Never-Blank Board — Implementation Plan (v2, post codex+gpt-oss review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine evaluates ~130 famous names every day, sees post-earnings dips (`day_losers` + a dip-buy lane with its own call constructor), and publishes a board that is never blank — top calls always shown, risk-sized by grade, near-misses named when nothing clears the gates.

**Architecture:** Three new pure modules (`spark.ts` batch closes, `coreSleeve.ts` sleeve + unusualness ranking, `dipLane.ts` dip classification **and dip-call construction**) feed `buildBoard` in `netlify/functions/lib/engine.ts`. The dip lane builds its own long call (a catalyst tag cannot — context can never set a side); dip calls are graded through `probabilityFor` like every call. Board assembly is restructured: half-size C trades, contract-fail trades at half size naming their missing evidence, unpicked actionable rows fall through to watch, and per-side near-miss rows guarantee the board is never nameless.

**Tech Stack:** TypeScript, vitest, Netlify Functions, Yahoo endpoints (free), Netlify Blobs via `AppStore`.

**Spec:** `docs/superpowers/specs/2026-08-11-funnel-and-regret-learning-design.md` §4.1 (core sleeve, day_losers, dip-buy lane), §4.2 (never-blank board bullet). Deferred BY DECISION to Stage 2 (spec §6 note): per-name expectation-scaled sizing — Stage 1 uses an interim flat `SLEEVE_CAPACITY_FLOOR`. Velocity/crypto (1b), scoring/grades (2), learning (3) are OUT.

**Review provenance:** v1 reviewed by codex (repo-grounded, 18 findings, FIX-FIRST) and gpt-oss-120b (2 accepted findings) on 2026-08-11. All accepted findings are folded in below and marked `[R#]` (codex) / `[G#]` (gpt-oss).

## Global Constraints

- Commits on `main`, imperative style; **NEVER add a Co-Authored-By trailer** (breaks the Netlify pipeline).
- **Do NOT push** until Task 7's replay evidence exists and the owner confirms — push = deploy.
- Everything fail-soft: any new fetch/module erroring must leave the board **identical to a run without the feature** (deep-compare, not length-compare) [R7].
- $0 data: Yahoo only, batched; no new paid APIs. Sleeve spark = ~7 chunked calls (130 names / 20), a few seconds — the spec's "1–2 calls" was optimistic, ~7 is still free [R16].
- Untouched in this stage: `CALIB_DEF_VERSION`, `ENGINE_MODEL_VERSION`, hit definition, bucket keys, `probabilityFor`, `gradeFor`, `riskLadder.ts` [R14], factor weights, dead-zone values.
- `addSource` keeps the FIRST source for a symbol (engine.ts:518) — never key sleeve/dip logic off the source string; use the sleeve Set / dip map [R1].
- Any new engine-owned config field MUST be added to the preserve list in `netlify/functions/config-sync.mts` (~line 151) or phone syncs wipe it [R8].
- Test runner: `npx vitest run <file>` (`npm test` for the suite). Suite green after every task.
- Line anchors as of commit `37ef9bc`.

---

### Task 1: Batched spark closes (`spark.ts`)

**Files:**
- Create: `netlify/functions/lib/spark.ts`
- Test: `netlify/functions/lib/spark.test.ts`

**Interfaces:**
- Produces: `parseSpark(json: unknown): Map<string, number[]>` (SYM → daily closes, oldest first, nulls dropped, keys upper-cased); `fetchSparkCloses(syms: string[], fetchFn?: typeof fetch): Promise<Map<string, number[]>>` — dedupes, chunks of 20, failed chunks skipped.

- [ ] **Step 1: Write the failing test** [R17: chunk test asserts exact chunk contents, not just count]

```ts
// netlify/functions/lib/spark.test.ts
import { describe, expect, it } from 'vitest'
import { fetchSparkCloses, parseSpark } from './spark'

const sparkJson = {
  AAPL: { timestamp: [1, 2, 3], close: [230.1, null, 232.5] },
  glw: { timestamp: [1, 2, 3], close: [48.2, 41.9, 42.7] },
  BAD: 'not-a-series',
}

describe('parseSpark', () => {
  it('maps symbols to close series, upper-cased, dropping nulls and junk', () => {
    const m = parseSpark(sparkJson)
    expect(m.get('AAPL')).toEqual([230.1, 232.5])
    expect(m.get('GLW')).toEqual([48.2, 41.9, 42.7])
    expect(m.has('BAD')).toBe(false)
  })
  it('returns empty map on garbage', () => {
    expect(parseSpark(null).size).toBe(0)
    expect(parseSpark({ finance: {} }).size).toBe(0)
  })
})

describe('fetchSparkCloses', () => {
  it('chunks at 20, each chunk carries the right symbols, dedupes input', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({}) }
    }) as unknown as typeof fetch
    const syms = [...Array.from({ length: 44 }, (_, i) => `s${i}`), 'S0', 'S1'] // dupes of s0/s1
    await fetchSparkCloses(syms, fetchFn)
    expect(urls).toHaveLength(3)
    const symsOf = (u: string) => decodeURIComponent(u.split('symbols=')[1].split('&')[0]).split(',')
    expect(symsOf(urls[0])).toHaveLength(20)
    expect(symsOf(urls[1])).toHaveLength(20)
    expect(symsOf(urls[2])).toEqual(['S40', 'S41', 'S42', 'S43']) // 44 unique after dedupe
    expect(new Set(urls.flatMap(symsOf)).size).toBe(44)
  })
  it('fails soft: a rejected chunk is skipped, others survive', async () => {
    let call = 0
    const fetchFn = (async () => {
      call += 1
      if (call === 1) throw new Error('boom')
      return { ok: true, json: async () => ({ B2: { close: [3] } }) }
    }) as unknown as typeof fetch
    const m = await fetchSparkCloses(Array.from({ length: 25 }, (_, i) => `s${i}`), fetchFn)
    expect(m.get('B2')).toEqual([3])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run netlify/functions/lib/spark.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// netlify/functions/lib/spark.ts
// Batched daily closes via Yahoo's crumb-free spark endpoint. The core sleeve's
// cheap eye: ~7 calls cover 130 names with 3 months of closes each. Fails soft
// per chunk — a refused chunk just means those names sit out today.

const CHUNK = 20

export function parseSpark(json: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>()
  if (!json || typeof json !== 'object') return out
  for (const [sym, v] of Object.entries(json as Record<string, unknown>)) {
    const close = (v as { close?: unknown })?.close
    if (!Array.isArray(close)) continue
    const closes = close.filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
    if (closes.length) out.set(sym.toUpperCase(), closes)
  }
  return out
}

export async function fetchSparkCloses(syms: string[], fetchFn: typeof fetch = fetch): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const upper = [...new Set(syms.map(s => s.toUpperCase()))]
  for (let i = 0; i < upper.length; i += CHUNK) {
    const chunk = upper.slice(i, i + CHUNK)
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=3mo&interval=1d`
      const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      if (!res.ok) continue
      for (const [sym, closes] of parseSpark(await res.json())) out.set(sym, closes)
    } catch {
      /* one dead chunk must not matter */
    }
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes** — same command, 4 tests PASS.

- [ ] **Step 5: Live-shape check (manual):** `node -e "fetch('https://query1.finance.yahoo.com/v8/finance/spark?symbols=AAPL,GLW&range=3mo&interval=1d',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json()).then(j=>console.log(Object.keys(j)))"` — if the live shape is the nested `{spark:{result:[...]}}` form, extend `parseSpark` to read BOTH shapes (fixture test for the second shape first).

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/lib/spark.ts netlify/functions/lib/spark.test.ts
git commit -m "feat(engine): batched spark closes — the cheap eye for the core sleeve"
```

---

### Task 2: Fetch `day_losers`

`ScreenKind` already includes `'day_losers'` (screener.ts:5) — this is wiring only.

**Files:**
- Modify: `netlify/functions/lib/engine.ts:168-179` (the `screens` dep in `defaultDeps`)
- Test: new file `netlify/functions/lib/engine.screens.test.ts` (module-mock isolation; `defaultDeps` must be imported there [R17])

- [ ] **Step 1: Failing test**

```ts
// netlify/functions/lib/engine.screens.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('./screener', () => ({
  fetchScreen: vi.fn(async () => []),
  fetchTrending: vi.fn(async () => []),
}))

import { fetchScreen } from './screener'
import { defaultDeps } from './engine'

describe('screens dep', () => {
  it('requests day_losers alongside the three existing screens', async () => {
    await defaultDeps({}).screens()
    const kinds = (fetchScreen as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(kinds).toContain('day_losers')
    expect(kinds).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Verify it fails** — `npx vitest run netlify/functions/lib/engine.screens.test.ts` → kinds length 3.

- [ ] **Step 3: Implement** — in `defaultDeps.screens` (engine.ts:170-174):

```ts
const kinds = [
  ['day_gainers', 'screener:gainers'],
  ['day_losers', 'screener:losers'],
  ['most_actives', 'screener:actives'],
  ['small_cap_gainers', 'screener:smallcap'],
] as const
```

- [ ] **Step 4: Full suite** — `npm test` green (watch fixtures that assumed 3 screens).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/engine.ts netlify/functions/lib/engine.screens.test.ts
git commit -m "feat(engine): fetch day_losers — the board can finally see what fell"
```

---

### Task 3: Core sleeve module + config field + sync preservation

**Files:**
- Create: `shared/engine/coreSleeve.ts`
- Test: `shared/engine/coreSleeve.test.ts`
- Modify: `shared/config.ts` (add `coreSleeve?: string[]`, validated, cap 200)
- Modify: `netlify/functions/config-sync.mts` (~line 151): add `coreSleeve` to the engine-only preserve list [R8 — the levMap/riskAppetite wipe trap]
- Test: extend `netlify/functions/lib/config-sync.test.ts` with a preservation case

**Interfaces:**
- Produces: `DEFAULT_CORE_SLEEVE: string[]` (~130 names); `sleeveWithDefaults(cfgSleeve: string[] | undefined | null): string[]` (union over defaults, upper-cased, deduped); `rankSleeve(closesBySym: Map<string, number[]>, topN: number): SleeveRank[]` with `SleeveRank = { sym: string; unusualness: number; typicalMovePct: number | null }`, `unusualness = |1-day move %| / max(typicalMovePct ?? 0.5, 0.5)`, `typicalMovePct` from `swingCapacity` (`shared/indicators.ts:60` — p80 of |10-session move|, the repo's one typical-move measure).

- [ ] **Step 1: Failing tests**

```ts
// shared/engine/coreSleeve.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CORE_SLEEVE, rankSleeve, sleeveWithDefaults } from './coreSleeve'

describe('DEFAULT_CORE_SLEEVE', () => {
  it('has 100-200 unique upper-case names including the famous ones', () => {
    expect(DEFAULT_CORE_SLEEVE.length).toBeGreaterThanOrEqual(100)
    expect(DEFAULT_CORE_SLEEVE.length).toBeLessThanOrEqual(200)
    expect(new Set(DEFAULT_CORE_SLEEVE).size).toBe(DEFAULT_CORE_SLEEVE.length)
    for (const sym of ['AAPL', 'NVDA', 'TSLA', 'GOOGL', 'GLW', 'AMD', 'PLTR', 'COIN', 'MSTR', 'RR.L', 'BP.L', 'SHEL.L'])
      expect(DEFAULT_CORE_SLEEVE).toContain(sym)
  })
})

describe('sleeveWithDefaults', () => {
  it('unions config names over defaults, deduped and upper-cased', () => {
    const s = sleeveWithDefaults(['aapl', 'ZZZZ'])
    expect(s.filter(x => x === 'AAPL')).toHaveLength(1)
    expect(s).toContain('ZZZZ')
    expect(s.length).toBe(new Set(s).size)
  })
  it('null/undefined leaves the defaults untouched', () => {
    expect(sleeveWithDefaults(null)).toEqual(DEFAULT_CORE_SLEEVE)
  })
})

describe('rankSleeve', () => {
  const flat = [...Array.from({ length: 62 }, () => 100), 112] // +12% on the last day
  const steady = Array.from({ length: 63 }, (_, i) => 100 * Math.pow(1.01, i % 2))
  it('ranks the unusual mover first and reports typical move', () => {
    const ranked = rankSleeve(new Map([['CALM', steady], ['MOVE', flat]]), 2)
    expect(ranked[0].sym).toBe('MOVE')
    expect(ranked[0].unusualness).toBeGreaterThan(ranked[1].unusualness)
    expect(ranked[0].typicalMovePct).not.toBeNull()
  })
  it('respects topN and skips series shorter than 30', () => {
    const ranked = rankSleeve(new Map([['SHORT', [1, 2, 3]], ['MOVE', flat]]), 5)
    expect(ranked.map(r => r.sym)).toEqual(['MOVE'])
  })
})
```

PLUS the sync test:

```ts
// in netlify/functions/lib/config-sync.test.ts, alongside the existing preserve cases
it('a phone payload without coreSleeve does not wipe the stored coreSleeve', async () => {
  // follow the file's existing preserve-test pattern for levMap/riskAppetite verbatim,
  // with stored config carrying coreSleeve: ['ZZZZ'] and an incoming payload omitting it;
  // assert the written blob still has coreSleeve ['ZZZZ'].
})
```

(Write it concretely in the file's established style — the levMap preservation test is the template to copy.)

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** `coreSleeve.ts`:

```ts
// shared/engine/coreSleeve.ts
// The standing sleeve of famous, liquid names the engine looks at EVERY day —
// the fix for "GLW dropped 15% and the movers scanner never saw it". Names here
// are permanent candidates: no roster join gate, no largest-cap-first trim.
// Curation beats cleverness: T212-routable, household, liquid. Owner can extend
// via config.coreSleeve (union, never replace — the withDefaults pattern).
import { swingCapacity } from '../indicators'

export const DEFAULT_CORE_SLEEVE: string[] = [
  // US megacaps + household tech
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC',
  'CRM', 'ORCL', 'ADBE', 'NFLX', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC',
  'NOW', 'UBER', 'ABNB', 'SHOP', 'SNOW', 'PANW', 'CRWD', 'ZS', 'DDOG', 'NET',
  // high-beta favourites / retail darlings
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'RBLX', 'DKNG', 'RIVN', 'LCID', 'SMCI',
  'ARM', 'DELL', 'IONQ', 'RGTI', 'AAOI', 'APP', 'CVNA', 'AFRM', 'UPST', 'RKLB',
  // US large-cap breadth: financials, health, industrials, energy, consumer
  'JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'V', 'MA', 'AXP', 'BLK',
  'UNH', 'LLY', 'JNJ', 'PFE', 'MRK', 'ABBV', 'TMO', 'AMGN', 'GILD', 'CVS',
  'CAT', 'DE', 'BA', 'GE', 'HON', 'LMT', 'RTX', 'NOC', 'UPS', 'FDX',
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'FCX', 'NEM', 'GLW', 'MMM', 'DOW',
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'DIS', 'CMCSA',
  'PG', 'KO', 'PEP', 'PM', 'T', 'VZ', 'TMUS', 'CSCO', 'IBM', 'PYPL',
  // liquid UK large caps (T212-routable)
  'RR.L', 'BP.L', 'SHEL.L', 'AZN.L', 'GSK.L', 'HSBA.L', 'BARC.L', 'LLOY.L', 'VOD.L', 'BT-A.L',
  'GLEN.L', 'RIO.L', 'AAL.L', 'TSCO.L', 'MKS.L', 'IAG.L', 'RMV.L', 'BA.L', 'STAN.L', 'PRU.L',
]

export function sleeveWithDefaults(cfgSleeve: string[] | undefined | null): string[] {
  const out = [...DEFAULT_CORE_SLEEVE]
  const seen = new Set(out)
  for (const raw of cfgSleeve ?? []) {
    const sym = raw.toUpperCase()
    if (!seen.has(sym)) { seen.add(sym); out.push(sym) }
  }
  return out
}

export interface SleeveRank { sym: string; unusualness: number; typicalMovePct: number | null }

/** Rank sleeve names by how unusual today's move is vs the name's OWN typical
 * 10-session move. A calm megacap doing +4% outranks a biotech doing +4%. */
export function rankSleeve(closesBySym: Map<string, number[]>, topN: number): SleeveRank[] {
  const ranked: SleeveRank[] = []
  for (const [sym, closes] of closesBySym) {
    if (closes.length < 30) continue
    const last = closes[closes.length - 1]
    const prev = closes[closes.length - 2]
    if (!prev) continue
    const movePct = Math.abs((last / prev - 1) * 100)
    const typicalMovePct = swingCapacity(closes)
    ranked.push({ sym, unusualness: movePct / Math.max(typicalMovePct ?? 0.5, 0.5), typicalMovePct })
  }
  return ranked.sort((a, b) => b.unusualness - a.unusualness).slice(0, topN)
}
```

(Check `swingCapacity`'s real export/signature in `shared/indicators.ts` first and adapt the import if it differs.) Plus:
  - `shared/config.ts`: `coreSleeve?: string[]` next to `levMap` (line 18); validate: strings, upper-case, `/^[A-Z0-9.\-]{1,12}$/`, `.slice(0, 200)`, emit only if non-empty (mirror levMap at lines 53-62, 106).
  - `config-sync.mts` ~151: add `coreSleeve` to the preserved engine-only fields, matching how `levMap` is carried.

- [ ] **Step 4: Verify** — module tests + config tests + config-sync tests green; `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add shared/engine/coreSleeve.ts shared/engine/coreSleeve.test.ts shared/config.ts netlify/functions/config-sync.mts netlify/functions/lib/config-sync.test.ts
git commit -m "feat(engine): the core sleeve — 130 famous names the engine never stops watching"
```

---

### Task 4: Dip lane — classification AND call construction (`dipLane.ts`)

[R3 — the load-bearing change from review] A catalyst tag is context and can never set a side; a dipped name's core momentum is negative, so `composeCall` would emit a SHORT. The dip lane therefore builds its own long call, graded through the normal calibration path (`probabilityFor` needs only side/regime/|composite|/cohort).

**Files:**
- Create: `shared/engine/dipLane.ts`
- Test: `shared/engine/dipLane.test.ts`
- Modify: `shared/engine/catalyst.ts:15` — **ADD** `'dip'` to the existing union `'news' | 'event' | 'ipo' | 'listing' | 'earnings'` (do NOT replace the union — existing code constructs `'event'` etc.) [R9]

**Interfaces:**
- Consumes: `Candle` from `'../types'` (the `roster.ts` import path — verified), `EngineCall`/`CallEvidence` from `'./types'`, `round1`/`round2`/`clamp` from `'./types'`.
- Produces:
  - `classifyDip(candles: Candle[]): DipRead | null` — null iff < 30 candles; `DipRead = { triggered: boolean; holding: boolean; dropPct: number; detail: string }`.
  - `dipCall(sym: string, candles: Candle[], read: DipRead, capUsdM: number | null): EngineCall | null` — null unless `triggered && holding`. Long only. `entry` = last close; `stop` = dip-window low (10-session min intraday low) `round2`; `target` = half-retrace toward the 20-session closing high; `composite` = `round1(clamp(25 + read.dropPct, 25, 55))` (deliberately inside the calibrated 25-55 bands — honest: dips are not high-band conviction); `setup: 'reversal'`; `stage: 'early-reversal'`; `evidence` built from the dip's own checks (`contract` true only when volume + reclaim/EMA + regime known — fields below); `note` = the dip detail.

Rules [G6 + R4 folded in]: trigger = drop ≥ 12% from the 20-session closing high, OR worst single-session decline ≥ 7% measured as `max(close-to-close drop, open-gap vs prior close)` within the last 10 sessions (uses `Candle.o`). Holding = NOT a new 5-session closing low today, AND volume ≥ 1.5× the 20-day average, AND (close > 50-EMA OR close ≥ 3% above the dip-window low — the slide case must have a reclaim path that doesn't require the far-away 50-EMA [G6]). Earnings/news linkage is NOT required in Stage 1 — the price signature suffices; the tag is narration.

Ratified at Task-4 review (2026-08-11, controller decision): **stop = min(dip-window low, today's intraday low)** (the brief's literal stop could sit inside today's range); **minimum 1:1 reward-to-risk** — `dipCall` returns null when `(target − entry) < (entry − stop)` (kills the depth-blind-gap degenerate: entry 99 / stop 90 / target 99.5 must never publish); `evidence.coverage`/`famAgree` are NOMINAL placeholders and must say so in a code comment. All dipCall null paths and the washout-bar stop semantics carry tests.

- [ ] **Step 1: Failing tests** — truth table:

```ts
// shared/engine/dipLane.test.ts
import { describe, expect, it } from 'vitest'
import { classifyDip, dipCall } from './dipLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
const base = () => Array.from({ length: 60 }, () => mk(100))

describe('classifyDip', () => {
  it('null when under 30 candles', () => expect(classifyDip([mk(1)])).toBeNull())
  it('calm tape: not triggered', () => expect(classifyDip(base())!.triggered).toBe(false))
  it('triggers on a >=12% slide from the 20-session high', () => {
    expect(classifyDip([...base(), mk(95), mk(90), mk(87)])!.triggered).toBe(true)
  })
  it('triggers on a one-day open-gap >=7% even when the close recovers', () => {
    // opens at 91 (-9% gap), closes back at 96 — close-to-close is only -4%
    expect(classifyDip([...base(), mk(96, 2_000_000, 91, 97, 90)])!.triggered).toBe(true)
  })
  it('knife guard: a new 5-session closing low today is never holding', () => {
    const read = classifyDip([...base(), mk(92), mk(90), mk(88), mk(86), mk(84)])!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
  })
  it('slide case holds via the 3%-above-dip-low reclaim on volume (no 50-EMA needed)', () => {
    // slide to 85 over days, stabilise at 85, then close 88 (+3.5% off the low) on 1.6x volume
    const cs = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_600_000)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
  })
  it('thin-volume reclaim is not holding', () => {
    const cs = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_100_000)]
    expect(classifyDip(cs)!.holding).toBe(false)
  })
})

describe('dipCall', () => {
  const holdingTape = [...base(), mk(94), mk(90), mk(87), mk(85, 1_000_000, 86, 86, 84.5), mk(85.5), mk(88, 1_600_000)]
  it('builds a LONG reversal call with stop under the dip low and composite in 25-55', () => {
    const read = classifyDip(holdingTape)!
    const call = dipCall('GLW', holdingTape, read, 35_000)!
    expect(call.side).toBe('long')
    expect(call.setup).toBe('reversal')
    expect(call.stop).toBeLessThan(84.6)
    expect(call.entry).toBe(88)
    expect(call.target).toBeGreaterThan(88)
    expect(Math.abs(call.composite)).toBeGreaterThanOrEqual(25)
    expect(Math.abs(call.composite)).toBeLessThanOrEqual(55)
  })
  it('returns null when not holding', () => {
    const notHolding = [...base(), mk(92), mk(90), mk(88), mk(86), mk(84)]
    expect(dipCall('GLW', notHolding, classifyDip(notHolding)!, 35_000)).toBeNull()
  })
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement** — `classifyDip` per the rules above (EMA seeded by SMA of the first n — the standard seeding; `dipWindowLow` = min intraday low of the last 10 sessions excluding today; `low5` = min closing low of the prior 4 sessions, guard fires when `last.c <= low5`); `dipCall` per the interface (evidence: `{ coverage: 1, famAgree: 2, contract: regimeKnownIsCallersProblem…— set contract: true, detail: read.detail }` — keep it simple: `contract: true` because the lane's own gates ARE its evidence contract; `expectedMovePct` = the retrace distance as % `round1`; `smallCap` from `capUsdM < 2000` matching composite.ts:146; `earningsRisk: false` — the engine loop overrides it from `earningsSet` at integration [Task 5]; `factors`: a minimal record with every factor `{ score: null, detail: 'dip lane' }` and `technical: { score: 40, detail: read.detail }` so downstream contributors/narration code has its expected shape — copy the exact `FactorScore & { weight }` shape from composite.ts:159-161 with weight 0).

- [ ] **Step 4: Verify** — dipLane tests PASS; `npm test` green (catalyst.ts union widened breaks nothing — it only adds).

- [ ] **Step 5: Commit**

```bash
git add shared/engine/dipLane.ts shared/engine/dipLane.test.ts shared/engine/catalyst.ts
git commit -m "feat(engine): dip lane builds its own long call — context tags cannot flip a side"
```

---

### Task 5: Wire sleeve + dip lane into `buildBoard`

**Files:**
- Modify: `netlify/functions/lib/engine.ts` (sleeve fetch ~487; sources ~511-597; priority ~605-617; budget 617; dip pass after cap enrichment ~629; compose loop ~704-761; dip-call merge after the loop)
- Modify: `shared/engine/composite.ts` (add `sleeve?: boolean` to `ComposeInput`; `SLEEVE_CAPACITY_FLOOR = 3`; floor line 137)
- Test: `netlify/functions/lib/engine.test.ts` (board harness cases), `shared/engine/composite.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4 exports.
- Produces: `EngineDeps.sparkCloses: (syms: string[]) => Promise<Map<string, number[]>>` (default impl wraps `fetchSparkCloses`); board rows for dip calls carry `catalyst: { kind: 'dip', reason }`. No `source` field is added to `Prediction` [R10 — assert sleeve presence by symbol, not by a new field].

- [ ] **Step 1: Failing tests** (write concretely in the file's existing stub-all-deps harness style):

```ts
it('a sleeve mover reaches evaluation even when no screen and no roster carry it', async () => {
  // deps.sparkCloses: GLW gets a big final-day move, others flat; screens/social empty;
  // roster blob empty. Assert GLW appears in the published predictions blob (any row kind).
})
it('a sleeve name arriving via day_losers still reaches evaluation when it fails the roster join gate', async () => {
  // GLW in screens as screener:losers with capacityPct below 8 (calm megacap candles);
  // assert GLW still evaluated (sleeveSet membership, not source string, drives the append). [R1]
})
it('sleeve names are not written into the roster', async () => {
  // run with sleeve movers; read the engine-roster blob written by the run;
  // assert none of the sleeve-only names joined it. [R2]
})
it('a holding dip on a quality name publishes a LONG reversal row with a dip tag', async () => {
  // GLW candles shaped like dipLane holding fixture, cap 35_000 (enrichment path);
  // assert row.side 'long', row.setup 'reversal', row.catalyst.kind 'dip'. [R3]
})
it('dip earnings override: a dip name inside the earnings window is shadowed like any call', async () => {
  // earningsSet contains GLW → the merged dip call gets earningsRisk true → shadow.
})
it('sleeve fetch failure leaves the run byte-identical to a sleeve-less run', async () => {
  // Run A: deps.sparkCloses rejects. Run B: feature-flag baseline (sleeveWithDefaults([]) forced empty).
  // Deep-compare published predictions of A and B: same rows, same sides, same sizes. [R7]
})
```

And in `composite.test.ts`:

```ts
it('sleeve names clear a lower capacity floor; non-sleeve keep floor 6', () => {
  const input = { ...buildInput(), capacityPct: 4, sleeve: true } // buildInput = the file's existing fixture helper
  expect(composeCall(input)).not.toBeNull()
  expect(composeCall({ ...input, sleeve: false })).toBeNull()
})
```

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement, in this order:**

(a) `composite.ts`: `sleeve?: boolean` on `ComposeInput`; `export const SLEEVE_CAPACITY_FLOOR = 3`; line 137:

```ts
const capacityFloor = input.sleeve ? SLEEVE_CAPACITY_FLOOR : input.catalyst ? gates.catalystCapacityFloor : gates.capacityFloor
```

(b) `engine.ts` — add `sparkCloses` to `EngineDeps` and `defaultDeps`. After the screens fetch (~487):

```ts
// The core sleeve: famous names evaluated every day. One spark batch ranks them
// by unusualness; the top movers join full evaluation. sleeveActive gates EVERY
// sleeve behaviour so a failed fetch runs exactly like a sleeve-less engine. [R7]
const sleeveSyms = sleeveWithDefaults(cfg.coreSleeve)
const sleeveCloses = await deps.sparkCloses(sleeveSyms).catch(() => new Map<string, number[]>())
const sleeveActive = sleeveCloses.size > 0
const sleeveTop = sleeveActive ? rankSleeve(sleeveCloses, 40) : []
const sleeveSet = new Set(sleeveActive ? sleeveSyms : [])
```

(c) Sources: after the theme door, `for (const r of sleeveTop) addSource(r.sym, 'sleeve')`. Priority: sleeve slots AFTER catalyst — key on the SET, not the source string [R1]:

```ts
if (catalystBySym.has(sym)) return 3
if (sleeveSet.has(sym)) return 4
if (sources.get(sym)?.source.startsWith('channel:')) return 5
if (sources.get(sym)?.source.startsWith('theme:') || sources.get(sym)?.source === 'rotation') return 6
if (sources.get(sym)?.source === 'social') return 7
return 8
```

Budget: `.slice(0, 110)` → `.slice(0, 180)`. (Worst case +70 candle fetches, bounded by mapLimit 8 — noted, accepted [R16].)

(d) **Dip pass AFTER cap enrichment** [R5] — move it below the `noCap` loop (~line 629):

```ts
// Dip lane: quality names (sleeve or >$10B) hit hard but holding become LONG
// candidates via their own call constructor — composeCall would read the same
// chart as a short (context can never flip a side). Merged after the main loop.
const dipReads = new Map<string, DipRead>()
for (const sym of candidateSyms) {
  const candles = candleMap.get(sym)
  if (!candles) continue
  const quality = sleeveSet.has(sym) || (sources.get(sym)?.capUsdM ?? 0) > 10_000
  if (!quality) continue
  const read = classifyDip(candles)
  if (read?.triggered && read.holding) dipReads.set(sym, read)
}
```

(e) **Roster isolation** [R2]: build the `candidates` array for `updateRoster` EXCLUDING names whose only door was the sleeve:

```ts
const rosterCandidates = candidates.filter(c => !(sleeveSet.has(c.sym) && sources.get(c.sym)?.source === 'sleeve'))
const { roster, joined, dropped } = updateRoster(currentRoster, rosterCandidates, watchSyms, today, Object.keys(cfg.levMap ?? {}))
```

(f) **Evaluation rows** — the compose loop iterates `roster` (line 705). Build instead:

```ts
const evalRows = [
  ...roster.map(e => ({ sym: e.sym, capUsdM: e.capUsdM })),
  ...candidateSyms
    .filter(sym => sleeveSet.has(sym) && !rosterSet.has(sym) && candleMap.has(sym))
    .map(sym => ({ sym, capUsdM: sources.get(sym)?.capUsdM ?? null })),
]
```

iterate `evalRows`, and pass `sleeve: sleeveActive && sleeveSet.has(entry.sym)` in `composeInput` (the second compose call at line 760 spreads the first input — one placement covers both).

(g0) **IC isolation for lane calls** (Task 4 implementer finding): dip calls carry a constant `technical: +40` placeholder score, so `updateIcStats` in the grading pass would book every dip outcome into the technical factor's IC as a perpetual "agree" — the lane's P&L silently training an unrelated factor. In `gradeOutstanding` (engine.ts:316-329), skip the `updateIcStats` call for predictions whose `catalyst?.kind === 'dip'` (calibration buckets and setup buckets still accrue — only factor-IC is excluded). Add an engine test: a graded dip prediction leaves the weights' IC observation counts untouched.

(g) **Dip-call merge** — after the compose loop, before shadow dedup (~line 832): for each `dipReads` entry whose sym did NOT produce a long call in the loop, build `dipCall(sym, candles, read, capUsdM)`; if non-null, set `earningsRisk = earningsSet.has(baseSym(sym))` [earnings honesty], then push it through the SAME post-compose pipeline as loop calls: cohort → `probabilityFor` → `gradeFor` → shadow/watchOnly/belowBase flags → `board.push({...})` with `catalyst: { kind: 'dip', reason: read.detail }`. Factor this shared post-compose block into a local function `publishCall(call, capUsdM, cat)` so the loop and the dip merge use ONE code path (no drift).

- [ ] **Step 4: Full suite + `npm run build`** — green; tsc clean.

- [ ] **Step 5: Dry-run** — `npx tsx scripts/engine-dry-run.ts` (read its header for usage): sleeve names visible among candidates, no crash.

- [ ] **Step 6: Commit**

```bash
git add -A shared netlify/functions/lib
git commit -m "feat(engine): sleeve and dip lane reach the board — famous names are candidates every day"
```

---

### Task 5b: Dip-news corroboration (owner addition, 2026-08-11)

A dip only trades when the news says overreaction, not broken thesis. Targeted and tiny: ≤5 fresh reads/day, verdicts cached 3 days.

**Files:**
- Create: `netlify/functions/lib/dipNews.ts`
- Test: `netlify/functions/lib/dipNews.test.ts`
- Modify: `netlify/functions/lib/engine.ts` (dip-merge block from Task 5g)

**Interfaces:**
- Consumes: the Finnhub key already in `defaultDeps(env)`; `callLlm`-style helper from `netlify/functions/lib/llm.ts` (read its exports first and use the established call pattern — the same fail-soft router `newsCatalysts` uses).
- Produces: `fetchCompanyNews(sym: string, fromISO: string, toISO: string, key: string, fetchFn?: typeof fetch): Promise<string[]>` (headlines, fail-soft []); `classifyDipNews(sym: string, headlines: string[], llmJson: (prompt: string) => Promise<unknown>): Promise<DipNewsVerdict>` with `DipNewsVerdict = { verdict: 'transient' | 'structural' | 'unclear', reason: string }`; `heuristicDipVerdict(headlines: string[]): DipNewsVerdict` (keyword fallback). New dep `EngineDeps.dipNews: (sym: string) => Promise<DipNewsVerdict>` whose default impl wires news fetch + LLM + heuristic fallback + a `dip-news:{sym}` blob cache with a 3-day TTL.

- [ ] **Step 1: Failing tests** — heuristic table (fraud/investigation/"cuts guidance"/bankruptcy/delisting → structural; "misses estimates"/"downgrade"/sector-sympathy phrasing → transient; empty → unclear); classifyDipNews parses a well-formed LLM JSON verdict, falls back to the heuristic on malformed output or a thrown call; engine tests: structural verdict → the merged dip row is `shadow` with the reason in `catalyst.reason`; transient → trades with reason; deps.dipNews rejecting → dip trades labelled "news unchecked" (fail-soft).
- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement.** LLM prompt (constrained, JSON-only): "TICKER dropped hard recently. Given ONLY these headlines, classify the cause: transient (overreaction, sympathy move, priced-in miss) | structural (fraud, investigation, guidance collapse, financing/going-concern, secular loss) | unclear. Return {verdict, reason} with a reason under 20 words." Cap ≤5 dipNews calls per run, ordered by dip size; skip (→ 'unclear', reason 'budget') beyond the cap. Cache verdicts in the `dip-news:{sym}` blob for 3 days before re-reading.
- [ ] **Step 4: Full suite green.**
- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/dipNews.ts netlify/functions/lib/dipNews.test.ts netlify/functions/lib/engine.ts
git commit -m "feat(engine): a dip only trades when the news reads overreaction, not broken thesis"
```

---

### Task 6: Never-blank board — half-size C, contract-fail half-size, near-misses named

**Files:**
- Modify: `netlify/functions/lib/engine.ts:794-830` (flags/riskPct), `:867-877` (assembly restructure [R13])
- Modify: `shared/engine/composite.ts` (export `coreCompositeOf` helper for near-misses [R11])
- Modify: `shared/engine/types.ts` (`Prediction.nearMiss?: true`)
- Modify: `src/components/EngineBoard.tsx` (~line 251 copy [R18]), `src/components/TodaysCalls.tsx` (~line 35 copy + add riskPct display [R18])
- Test: `netlify/functions/lib/engine.test.ts`

**Interfaces:**
- Produces: `riskPct` = full for A/B+contract, HALF for (C+contract) and (A/B without contract) [R12]; contract-fail trades carry their `evidence.detail` (already on every call) surfaced by the UI; `coreCompositeOf(factors, weights, regime): number | null` (the dead-zone-free core read, extracted from composeCall's own maths); near-miss rows: `nearMiss: true, watchOnly: true, riskPct: 0, grade: 'C', probability: engine base rate`.
- C-grade longs have `instrument: null` and `paperOnly` false (a plain share buy — `leverageAllowed` is 0 for C and `riskLadder.ts` is NOT touched [R14]); C shorts without a route stay shadows exactly as today.

- [ ] **Step 1: Failing tests:**

```ts
it('grade C with contract passes as a half-size trade (no instrument, not paperOnly for longs)', async () => {
  // plant calibration → C + contract true. Assert: watchOnly undefined, riskPct === RUNG_RISK_PCT[rung]/2,
  // instrument null, paperOnly falsy. [R12][R14]
})
it('an A/B call that fails the contract trades at half size and names its evidence', async () => {
  // plant grade B + contract false. Assert riskPct half, watchOnly undefined, evidence.detail non-empty. [R12]
})
it('unpicked C trades fall through to the watch list, not into the void', async () => {
  // 5 C-longs same sector → diversity caps trades at 3; assert the other 2 appear as watchOnly rows. [R13]
})
it('a day where every candidate dies at the gates still names near-misses per side', async () => {
  // all composites under the dead zone → assert board contains nearMiss rows (>=1 per side that had
  // any core read), riskPct 0, and the blob is non-empty. [R11]
})
```

(Drop the v1 below-base visibility test — it already passes today and proves nothing new [R17].)

- [ ] **Step 2: Verify failures.**

- [ ] **Step 3: Implement:**

(a) `composite.ts` — extract the core read so near-misses reuse composeCall's exact maths:

```ts
/** The gate-free core read: weighted core composite after regime scaling.
 * composeCall's own first half, exported so the board can NAME its nearest
 * misses on a day nothing clears the gates. Returns null when no core data. */
export function coreCompositeOf(
  factors: Record<FactorName, FactorScore>,
  weights: Record<FactorName, number>,
  regime: RegimeColor | 'unknown',
): number | null {
  let num = 0, den = 0
  for (const name of Object.keys(factors) as FactorName[]) {
    if (FACTOR_FAMILY[name] !== 'core') continue
    const f = factors[name]
    if (f.score == null) continue
    num += (weights[name] ?? 0) * f.score
    den += weights[name] ?? 0
  }
  if (!den) return null
  const raw = num / den
  const side: 'long' | 'short' = raw >= 0 ? 'long' : 'short'
  return round1(raw * (side === 'long' ? LONG_REGIME_MULT[regime] : SHORT_REGIME_MULT[regime]))
}
```

Refactor `composeCall`'s first half to call it (one maths, two consumers).

(b) `engine.ts` flags (~794-830):

```ts
const fullTrade = !shadow && (grade === 'A' || grade === 'B') && call.evidence.contract
const halfTrade = !shadow && !fullTrade && grade != null && (grade !== 'C' || call.evidence.contract)
  // = C+contract, or A/B without contract. C WITHOUT contract stays watch. [R12]
const watchOnly = !shadow && !fullTrade && !halfTrade
```

`riskPct: shadow || watchOnly ? 0 : (halfTrade ? RUNG_RISK_PCT[rung] / 2 : RUNG_RISK_PCT[rung])`; `instrument` only for `fullTrade` shorts/leverage as today (`mapInstrument` call sites unchanged — C returns null by itself).

(c) Near-misses: in the compose loop, when `composeCall` returns null, record `{ sym, core: coreCompositeOf(factors, weights.current, regime), capUsdM }` (skip null cores). After assembly, for each side with fewer than 1 trade+watch rows, push up to 2 near-miss rows (largest |core| of that side's sign) as minimal `Prediction` rows: `nearMiss: true, watchOnly: true, riskPct: 0, grade: 'C', probability: round2(engineBaseRate), composite: core, note: 'nearest miss — did not clear the gates'` with entry/stop/target from lastClose/ATR as composeCall would (or entry-only with stop=target=null if the types require optionality — follow `Prediction`'s actual optional fields in types.ts:71).

(d) Assembly restructure [R13] — compute in this order:

```ts
const actionablePool = board.filter(b => !b.shadow && !b.watchOnly)
const trades = [...pickDiverseSide(actionablePool, 'long', 3, 'trade'), ...pickDiverseSide(actionablePool, 'short', 3, 'trade')]
const picked = new Set(trades.map(t => t.id))
for (const b of actionablePool) if (!picked.has(b.id)) { b.watchOnly = true; b.riskPct = 0; b.instrument = null } // fall through, not out [R13]
const watchPool = board.filter(b => !b.shadow && b.watchOnly)
const watch = [...pickDiverseSide(watchPool, 'long', 6, 'watch'), ...pickDiverseSide(watchPool, 'short', 6, 'watch')]
```

(e) UI [R18]: `EngineBoard.tsx:251` and `TodaysCalls.tsx:35` copy currently says only A/B full-evidence calls carry size — rewrite to: "A/B carry full size; C and thin-evidence calls carry half size; below-base and near-miss rows are watch-only." Add a risk line to `TodaysCalls` rows (it does not print riskPct today): `{p.riskPct > 0 ? `${p.riskPct}% risk${p.riskPct < RUNG_RISK_PCT[p.riskRung] ? ' (half size)' : ''}` : 'watch only'}`. Add the whole-side empty state: when a side has only nearMiss rows, the section header notes "nothing cleared the gates today — nearest misses shown".

- [ ] **Step 4: Full suite + `npm run build`** — green.

- [ ] **Step 5: Commit**

```bash
git add -A netlify/functions/lib shared src
git commit -m "feat(board): never blank — half-size C, contract-fail trades name their gap, near-misses named"
```

---

### Task 7: Replay harness + acceptance (ship gate)

[R15] The existing `scripts/engine-replay.ts` drives `composeCall` over a fixed 50-symbol universe on 5 Mondays — it cannot measure this stage. Build a real window replay that drives `buildBoard`.

**Files:**
- Create: `scripts/replay-window.ts`
- Create: `docs/superpowers/plans/2026-08-11-stage1-replay-results.md`

**Design (documented approximations are part of the deliverable):**
- In-memory `AppStore` stub (Map-backed read/write) seeded with the real `config` blob shape (levMap from repo fixtures) — fresh per replayed day, except roster/calibration blobs which CARRY across days (that's the point of a window).
- `deps.candles(sym)` = full 1y Yahoo fetch ONCE per sym (disk-cached under `scratch/replay-candles/`), sliced to bars ≤ the replayed date. `deps.sparkCloses` derived from the same cache. `deps.screens` = synthesized per day: top-25 |1-day move| gainers, losers, and $-volume actives from the union of {sleeve ∪ the 25 mirror-window tickers ∪ roster}, documented as an approximation of Yahoo's real screens. All LLM/social/news/insider/13F/holdings deps = empty/null (price-only replay — same honesty rule as the deep seed, spec §4.4).
- `--baseline` flag: force `sleeveWithDefaults([])` → empty, skip day_losers, and use the pre-Stage-1 flag logic (`watchOnly = C||null||!contract`, no near-misses) via a `LEGACY_BOARD=1` env branch in engine.ts guarded to the replay only — if that branch is too invasive, run baseline from a `git worktree` checkout of `37ef9bc` instead (document which was used).
- Output per day: date, trades (sym/side/grade/riskPct), watch count, nearMiss count, blank-sides count.

- [ ] **Step 1:** Build the script; smoke-test on 3 days.
- [ ] **Step 2:** Run baseline vs new over 2026-07-14 → 2026-08-11; write `stage1-replay-results.md`: (1) blank-board days before vs after (target after: 0); (2) GLW candidacy + dip-tag dates around its earnings drop; (3) sleeve names that reached a board; (4) grade distribution + C-as-trade count; (5) win5/avg5 both runs (no regression beyond noise on this small window).
- [ ] **Step 3:** Criterion fails → STOP, write it up honestly, bring it to the owner. No silent threshold-tuning.
- [ ] **Step 4:** Commit results. **No push until the owner has seen them.**

```bash
git add scripts/replay-window.ts docs/superpowers/plans/2026-08-11-stage1-replay-results.md
git commit -m "test(replay): stage 1 acceptance evidence over the mirrored window"
```

---

## Review-Response Log (v1 → v2)

Accepted: codex #1-#18 (all), gpt-oss B6 (slide-case reclaim), B2 (classifyDip contract documented: null only for short series).
Rejected with verification: gpt-oss A1 (artifact of the review payload's elided ticker list), A2 (`swingCapacity` IS the repo's typical-move measure — same p80 |10-session| units), A3 (global fetch is the repo norm on Node 18/Netlify), A5 (`ScreenKind` already contains `day_losers`), B1 (`'../types'` from `shared/engine/` resolves — `roster.ts:1` uses it), B3 (SMA seeding is the standard EMA seed), B4 (the knife-guard inequality fires correctly when today is the 5-session low: `last.c <= min(prior 4 closes)`), B5 (window-semantics nit, behaviour as intended).
Spec deltas recorded: per-name expectation-scaled sizing deferred to Stage 2 (§6 note) [R6]; spark call count corrected to ~7 [R16].
