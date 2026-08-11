# Stage 1: Seeing + Never-Blank Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine evaluates ~120 famous names every day, sees post-earnings dips (`day_losers` + a dip-buy lane), and publishes a board that is never blank — top calls always shown, risk-sized by grade.

**Architecture:** Three new pure modules (`spark.ts` batch closes, `coreSleeve.ts` sleeve + unusualness ranking, `dipLane.ts` dip classification) feed the existing `buildBoard` pipeline in `netlify/functions/lib/engine.ts` through the established candidate-source pattern (`addSource`). The dip lane rides the existing `CatalystTag` machinery (capacity relax + factor vote). Board assembly changes make grade C tradeable at half size and below-base rows visible.

**Tech Stack:** TypeScript, vitest, Netlify Functions, Yahoo endpoints (free), Netlify Blobs via `AppStore`.

**Spec:** `docs/superpowers/specs/2026-08-11-funnel-and-regret-learning-design.md` §4.1 (core sleeve, day_losers, dip-buy lane, capacity rethink), §4.2 (never-blank board bullet only). Velocity/crypto (Stage 1b), scoring/grades (Stage 2), learning (Stage 3) are OUT of this plan.

## Global Constraints

- Commits on `main`, imperative style like the log; **NEVER add a Co-Authored-By trailer** (breaks the Netlify pipeline).
- **Do NOT push** until the final replay-acceptance task passes and the owner confirms — push = deploy.
- Everything fail-soft: any new fetch/module erroring must leave the board buildable exactly as today.
- $0 data: Yahoo only, batched; no new paid APIs.
- Untouched in this stage: `CALIB_DEF_VERSION`, `ENGINE_MODEL_VERSION`, hit definition, bucket keys, `probabilityFor`, `gradeFor`, factor weights, dead zone values.
- Test runner: `npx vitest run <file>` (script: `npm test`). Suite must stay green after every task.
- Line anchors below are as of commit `6766ca8`.

---

### Task 1: Batched spark closes (`spark.ts`)

One crumb-free Yahoo spark call per ~20 symbols returns 3 months of daily closes — enough for today's move, typical move, and 20-session highs. This is the cheap eye that watches the whole sleeve.

**Files:**
- Create: `netlify/functions/lib/spark.ts`
- Test: `netlify/functions/lib/spark.test.ts`

**Interfaces:**
- Produces: `parseSpark(json: unknown): Map<string, number[]>` (sym → daily closes, oldest first, nulls dropped); `fetchSparkCloses(syms: string[], fetchFn?: typeof fetch): Promise<Map<string, number[]>>` — chunks of 20, failed chunks skipped (fail-soft), symbols upper-cased.

- [ ] **Step 1: Write the failing test**

```ts
// netlify/functions/lib/spark.test.ts
import { describe, expect, it } from 'vitest'
import { fetchSparkCloses, parseSpark } from './spark'

const sparkJson = {
  AAPL: { timestamp: [1, 2, 3], close: [230.1, null, 232.5] },
  GLW: { timestamp: [1, 2, 3], close: [48.2, 41.9, 42.7] },
  BAD: 'not-a-series',
}

describe('parseSpark', () => {
  it('maps symbols to close series, dropping nulls and junk entries', () => {
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
  it('chunks requests at 20 symbols and merges results', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ A1: { close: [1, 2] } }) }
    }) as unknown as typeof fetch
    const syms = Array.from({ length: 45 }, (_, i) => `s${i}`)
    const m = await fetchSparkCloses(syms, fetchFn)
    expect(urls.length).toBe(3) // 20 + 20 + 5
    expect(urls[0]).toContain('symbols=S0')
    expect(m.get('A1')).toEqual([1, 2])
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run netlify/functions/lib/spark.test.ts`
Expected: FAIL — `Cannot find module './spark'`

- [ ] **Step 3: Write minimal implementation**

```ts
// netlify/functions/lib/spark.ts
// Batched daily closes via Yahoo's crumb-free spark endpoint. The core sleeve's
// cheap eye: ~6 calls cover 120 names with 3 months of closes each. Fails soft
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run netlify/functions/lib/spark.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Live-shape check (manual, no commit blocker)**

Run: `node -e "fetch('https://query1.finance.yahoo.com/v8/finance/spark?symbols=AAPL,GLW&range=3mo&interval=1d',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.json()).then(j=>console.log(Object.keys(j), (j.AAPL&&(j.AAPL.close||[]).length)))"`
Expected: keys include `AAPL`, close length ≈ 63. If the live shape is `{spark:{result:[{symbol, response:[{indicators:{quote:[{close}]}}]}]}}` instead, extend `parseSpark` to read BOTH shapes (add a fixture test for the second shape first), keeping the flat-shape tests green.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/lib/spark.ts netlify/functions/lib/spark.test.ts
git commit -m "feat(engine): batched spark closes — the cheap eye for the core sleeve"
```

---

### Task 2: Fetch `day_losers`

**Files:**
- Modify: `netlify/functions/lib/engine.ts:168-179` (the `screens` dep)
- Test: `netlify/functions/lib/engine.test.ts` (existing file — add one test near the other deps tests)

**Interfaces:**
- Produces: screen source string `'screener:losers'` now appears in `sources` (consumed by Task 5's dip lane).

- [ ] **Step 1: Write the failing test.** In `netlify/functions/lib/engine.test.ts`, find how existing tests build `defaultDeps` or stub `screens`; add:

```ts
import { vi } from 'vitest'
it('screens dep requests day_losers alongside the three existing screens', async () => {
  const screener = await import('./screener')
  const spy = vi.spyOn(screener, 'fetchScreen').mockResolvedValue([])
  const trending = vi.spyOn(screener, 'fetchTrending').mockResolvedValue([])
  const deps = defaultDeps({})
  await deps.screens()
  const kinds = spy.mock.calls.map(c => c[0])
  expect(kinds).toContain('day_losers')
  expect(kinds).toHaveLength(4)
  spy.mockRestore(); trending.mockRestore()
})
```

(If `vi.spyOn` on the module namespace fails under the repo's ESM setup, use `vi.mock('./screener', ...)` in a NEW small test file `engine.screens.test.ts` instead — same assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run netlify/functions/lib/engine.test.ts -t day_losers`
Expected: FAIL — kinds has length 3, no `day_losers`

- [ ] **Step 3: Implement.** In `engine.ts` `defaultDeps.screens`, extend the kinds tuple:

```ts
const kinds = [
  ['day_gainers', 'screener:gainers'],
  ['day_losers', 'screener:losers'],
  ['most_actives', 'screener:actives'],
  ['small_cap_gainers', 'screener:smallcap'],
] as const
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. (Watch specifically for board-count fixtures that assumed 3 screens.)

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/engine.ts netlify/functions/lib/engine.test.ts
git commit -m "feat(engine): fetch day_losers — the board can finally see what fell"
```

---

### Task 3: Core sleeve module (`coreSleeve.ts`)

**Files:**
- Create: `shared/engine/coreSleeve.ts`
- Test: `shared/engine/coreSleeve.test.ts`
- Modify: `shared/config.ts` (add `coreSleeve?: string[]`, validated like `watchlist` symbols, cap 200)

**Interfaces:**
- Produces: `DEFAULT_CORE_SLEEVE: string[]` (~120 names); `sleeveWithDefaults(cfgSleeve: string[] | undefined | null): string[]` (union, upper-cased, deduped — the `withDefaults` pattern from `shared/channels.ts:26`); `rankSleeve(closesBySym: Map<string, number[]>, topN: number): { sym: string; unusualness: number; typicalMovePct: number | null }[]` where `unusualness = |1-day move %| / max(typicalMovePct, 0.5)` and `typicalMovePct` = p80 of |10-session % move| over the series (reuse `swingCapacity` from `shared/indicators.ts` — import it, don't reimplement).

- [ ] **Step 1: Write the failing test**

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
  it('null/undefined → defaults untouched', () => {
    expect(sleeveWithDefaults(null)).toEqual(DEFAULT_CORE_SLEEVE)
  })
})

describe('rankSleeve', () => {
  // 60 flat closes then a big final move = high unusualness; steady ±1% = low
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

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run shared/engine/coreSleeve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

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

Then in `shared/config.ts`: add `coreSleeve?: string[]` to the config interface (next to `levMap` at line 18), and in `validateConfig` accept an array of strings, upper-case + `/^[A-Z0-9.\-]{1,12}$/` filter + `.slice(0, 200)`, emitting `coreSleeve: arr.length ? arr : undefined` (mirror how `levMap` is validated at lines 53-62 and emitted at line 106).

- [ ] **Step 4: Verify** — `npx vitest run shared/engine/coreSleeve.test.ts` PASS, then `npm test` green (config tests may need the new field in fixtures — extend, don't weaken).

- [ ] **Step 5: Sanity-check the sleeve against T212** (manual): the July catalogue pull (memory: 17,338 instruments) confirmed route coverage patterns; spot-check 5 UK tickers exist on T212 web. Any name that isn't tradeable stays in the sleeve only if famous enough to matter for context (it can still be watch).

- [ ] **Step 6: Commit**

```bash
git add shared/engine/coreSleeve.ts shared/engine/coreSleeve.test.ts shared/config.ts
git commit -m "feat(engine): the core sleeve — 120 famous names the engine never stops watching"
```

---

### Task 4: Dip-buy lane module (`dipLane.ts`)

**Files:**
- Create: `shared/engine/dipLane.ts`
- Test: `shared/engine/dipLane.test.ts`

**Interfaces:**
- Consumes: `Candle` from `shared/types` (`{ t, o, h, l, c, v }`); `ema` from `shared/indicators` if exported (check `shared/indicators.ts`; if only `sma` exists, implement `ema` locally here with the standard 2/(n+1) smoothing).
- Produces: `classifyDip(candles: Candle[]): DipRead | null` where `DipRead = { triggered: boolean; holding: boolean; detail: string }`. Task 5 treats `triggered && holding` as a dip tag.

Spec truth table (§4.1): trigger = drop ≥ 12% from the 20-session closing high, OR a single-day gap-down ≥ 7%. Holding = (close back above the 50-EMA OR reclaim of the trigger-day low) AND volume on the reclaim/stabilise day ≥ 1.5× the 20-day average. Knife guard: NOT holding if today made a new 5-session closing low.

- [ ] **Step 1: Write the failing test** — a truth table over synthetic candles:

```ts
// shared/engine/dipLane.test.ts
import { describe, expect, it } from 'vitest'
import { classifyDip } from './dipLane'
import type { Candle } from '../types'

const mk = (c: number, v = 1_000_000, o = c, h = c, l = c): Candle => ({ t: 0, o, h, l, c, v })
/** 60 flat sessions at 100, then the scripted tail. */
const base = () => Array.from({ length: 60 }, () => mk(100))

describe('classifyDip', () => {
  it('null when under 30 candles', () => {
    expect(classifyDip([mk(1), mk(2)])).toBeNull()
  })
  it('no trigger on a calm tape', () => {
    expect(classifyDip(base())!.triggered).toBe(false)
  })
  it('triggers on a ≥12% slide from the 20-session high', () => {
    const cs = [...base(), mk(95), mk(90), mk(87)] // -13% from 100
    expect(classifyDip(cs)!.triggered).toBe(true)
  })
  it('triggers on a one-day gap-down ≥7%', () => {
    const cs = [...base(), mk(92, 3_000_000)] // -8% in one session
    expect(classifyDip(cs)!.triggered).toBe(true)
  })
  it('not holding while still making new 5-session lows (knife guard)', () => {
    const cs = [...base(), mk(92), mk(90), mk(88), mk(86), mk(84)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(false)
  })
  it('holding once the trigger-day low is reclaimed on 1.5x volume', () => {
    // gap to 88 (trigger, low 87), stabilise, then reclaim 89 on heavy volume
    const cs = [...base(), mk(88, 1_000_000, 95, 95, 87), mk(88), mk(89.5, 1_600_000)]
    const read = classifyDip(cs)!
    expect(read.triggered).toBe(true)
    expect(read.holding).toBe(true)
  })
  it('NOT holding when the reclaim volume is thin', () => {
    const cs = [...base(), mk(88, 1_000_000, 95, 95, 87), mk(88), mk(89.5, 1_100_000)]
    expect(classifyDip(cs)!.holding).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run shared/engine/dipLane.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// shared/engine/dipLane.ts
// The GLW lane: a QUALITY name hit hard that is now HOLDING is a long
// candidate, not a short. Trigger finds the damage; holding demands evidence
// of the turn (reclaim or 50-EMA on real volume) and refuses falling knives.
// Eligibility (sleeve or cap > $10B) is the CALLER's job — this module only
// reads the chart.
import type { Candle } from '../types'

export interface DipRead { triggered: boolean; holding: boolean; detail: string }

const emaLast = (values: number[], n: number): number | null => {
  if (values.length < n) return null
  const k = 2 / (n + 1)
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

export function classifyDip(candles: Candle[]): DipRead | null {
  if (candles.length < 30) return null
  const closes = candles.map(c => c.c)
  const last = candles[candles.length - 1]
  const high20 = Math.max(...closes.slice(-20))
  const dropPct = (1 - last.c / high20) * 100

  // find the trigger day inside the last 10 sessions: the worst single-session drop
  let gapPct = 0
  let triggerIdx = -1
  for (let i = Math.max(1, candles.length - 10); i < candles.length; i++) {
    const d = (1 - closes[i] / closes[i - 1]) * 100
    if (d > gapPct) { gapPct = d; triggerIdx = i }
  }
  const triggered = dropPct >= 12 || gapPct >= 7
  if (!triggered) return { triggered, holding: false, detail: 'no dip' }

  // knife guard: a new 5-session closing low today is not a turn
  const low5 = Math.min(...closes.slice(-5, -1))
  if (last.c <= low5) return { triggered, holding: false, detail: `down ${dropPct.toFixed(0)}% and still falling` }

  const vol20 = candles.slice(-21, -1).reduce((s, c) => s + c.v, 0) / 20
  const volumeOk = vol20 > 0 && last.v >= 1.5 * vol20
  const ema50 = emaLast(closes, 50)
  const aboveEma = ema50 != null && last.c > ema50
  const reclaimed = triggerIdx >= 0 && last.c > candles[triggerIdx].l
  const holding = volumeOk && (aboveEma || reclaimed)
  return {
    triggered,
    holding,
    detail: holding
      ? `dip ${dropPct.toFixed(0)}% from 20d high, ${aboveEma ? 'back above 50-EMA' : 'reclaimed the trigger low'} on ${(last.v / vol20).toFixed(1)}x volume`
      : `dip ${dropPct.toFixed(0)}%, waiting for a held reclaim on volume`,
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run shared/engine/dipLane.test.ts` PASS (7 tests). Adjust ONLY test fixtures if an assertion mis-modelled the maths; never weaken the knife guard.

- [ ] **Step 5: Commit**

```bash
git add shared/engine/dipLane.ts shared/engine/dipLane.test.ts
git commit -m "feat(engine): dip-buy lane — a hard hit that is holding is a long, not a short"
```

---

### Task 5: Wire sleeve + dip lane into `buildBoard`

The integration task. Everything rides existing rails: `addSource` for discovery, `CatalystTag` for the dip vote + capacity relax, `ComposeInput` for the sleeve floor.

**Files:**
- Modify: `netlify/functions/lib/engine.ts` (sources block ~511-597, priority ~605-617, budget 617, compose loop ~704-761)
- Modify: `shared/engine/catalyst.ts` (allow `kind: 'dip'` in `CatalystTag`)
- Modify: `shared/engine/composite.ts` (sleeve capacity floor)
- Test: `netlify/functions/lib/engine.test.ts`, `shared/engine/composite.test.ts` (existing files)

**Interfaces:**
- Consumes: `fetchSparkCloses` (Task 1), `sleeveWithDefaults`/`rankSleeve` (Task 3), `classifyDip` (Task 4), `'screener:losers'` rows (Task 2).
- Produces: `EngineDeps.sparkCloses: (syms: string[]) => Promise<Map<string, number[]>>` (new dep, default impl = `fetchSparkCloses`); `ComposeInput.sleeve?: boolean`; `CatalystTag.kind` union gains `'dip'`; `SLEEVE_CAPACITY_FLOOR = 3` exported from `composite.ts`. Board rows from the sleeve carry `source: 'sleeve'`; dip candidates carry a catalyst tag `{ kind: 'dip', side: 'long', reason, strength: 50 }`.

- [ ] **Step 1: Failing tests first.** In `shared/engine/composite.test.ts` add:

```ts
it('sleeve names clear a lower capacity floor', () => {
  const input = { ...baseComposeInput(), capacityPct: 4, sleeve: true } // baseComposeInput: reuse the file's existing fixture builder (its name may differ — match the file)
  expect(composeCall(input)).not.toBeNull()
  expect(composeCall({ ...input, sleeve: false })).toBeNull() // floor 6 still holds for non-sleeve
})
```

In `netlify/functions/lib/engine.test.ts` (using the file's existing `buildBoard` harness with stubbed deps — match its fixture style) add three tests:

```ts
it('sleeve movers join the candidate pool without roster membership', async () => {
  // stub deps.sparkCloses to return a big final-day move for GLW and flat for others;
  // run buildBoard; assert the roster-log/candidates saw GLW (source 'sleeve') even
  // though GLW is in no screen, no roster, no watchlist.
})
it('a triggered-and-holding dip gets a dip catalyst tag and can call long', async () => {
  // candles fixture for GLW shaped like dipLane.test's holding case; assert the
  // published GLW row (any of board/watch) has catalyst.kind 'dip' and side 'long'.
})
it('sleeve quote failure leaves the board identical to a no-sleeve run', async () => {
  // deps.sparkCloses rejects → buildBoard must not throw and board length matches baseline.
})
```

Write them as REAL tests against the harness, not comments — the three comment blocks above describe intent; the implementing engineer fills them using the file's established stub helpers (the file already stubs every dep for `buildBoard` tests — copy the nearest existing test's setup).

- [ ] **Step 2: Run to verify they fail** — `npx vitest run shared/engine/composite.test.ts netlify/functions/lib/engine.test.ts`

- [ ] **Step 3: Implement, in this order:**

(a) `shared/engine/catalyst.ts`: widen the tag union — `kind: 'news' | 'ipo' | 'dip'`.

(b) `shared/engine/composite.ts`: add to `ComposeInput`: `sleeve?: boolean`. Export `export const SLEEVE_CAPACITY_FLOOR = 3`. Change the floor line (137-138) to:

```ts
const capacityFloor = input.sleeve ? SLEEVE_CAPACITY_FLOOR : input.catalyst ? gates.catalystCapacityFloor : gates.capacityFloor
```

(c) `netlify/functions/lib/engine.ts`:
- Add `sparkCloses` to `EngineDeps` (line ~67) and to `defaultDeps`: `sparkCloses: async syms => { const { fetchSparkCloses } = await import('./spark'); return fetchSparkCloses(syms) }`.
- After the screens/social fetch (~line 487), add the sleeve read (fail-soft):

```ts
// The core sleeve: famous names evaluated every day. One spark batch ranks them
// by unusualness; the top movers join full evaluation, the rest cost one row.
const sleeveSyms = sleeveWithDefaults(cfg.coreSleeve)
const sleeveCloses = await deps.sparkCloses(sleeveSyms).catch(() => new Map<string, number[]>())
const sleeveTop = rankSleeve(sleeveCloses, 40)
const sleeveSet = new Set(sleeveSyms)
```

- In the sources block, after the theme door (~line 526): `for (const r of sleeveTop) addSource(r.sym, 'sleeve')`.
- Priority: in `candidatePriority`, insert sleeve between catalyst and channel — change the tail to:

```ts
if (catalystBySym.has(sym)) return 3
if (sources.get(sym)?.source === 'sleeve') return 4
if (sources.get(sym)?.source.startsWith('channel:')) return 5
if (sources.get(sym)?.source.startsWith('theme:') || sources.get(sym)?.source === 'rotation') return 6
if (sources.get(sym)?.source === 'social') return 7
return 8
```

- Budget: `.slice(0, 110)` → `.slice(0, 180)` (line 617).
- Dip tagging, after candles load (insert right after the `candleMap` fill, ~line 622): for each candidate with candles, if it is dip-eligible (`sleeveSet.has(sym)` OR `(sources.get(sym)?.capUsdM ?? 0) > 10_000`) and `classifyDip(candles)` returns `triggered && holding`, and the sym has no existing catalyst tag: `catalystBySym.set(sym, { kind: 'dip', side: 'long', reason: read.detail, strength: 50 })`. (This buys the relaxed capacity floor + a catalyst-factor long vote through machinery that already exists end-to-end.)
- **Sleeve names must reach the compose loop without roster membership.** The compose loop iterates `roster` (line 705). Extend it: build `const evalRows: { sym: string; capUsdM: number | null; source: string }[] = [...roster.map(e => ({ sym: e.sym, capUsdM: e.capUsdM, source: e.source }))]`, then append every sleeve-sourced candidate not already in the roster (`sources.get(sym)?.source === 'sleeve'`, `capUsdM` from `sources`). Iterate `evalRows` instead of `roster`, and pass `sleeve: sleeveSet.has(entry.sym)` in `composeInput` (both compose calls — line 748 spreads the first input, so one flag placement covers both).

- [ ] **Step 4: Full suite** — `npm test` green. The roster tests must be untouched (sleeve bypasses the roster; it never writes to it).

- [ ] **Step 5: Dry-run locally** — `npx tsx scripts/engine-dry-run.ts` (check the script's own usage header first). Expected: log shows sleeve names among candidates; no crash with the network on.

- [ ] **Step 6: Commit**

```bash
git add -A shared netlify/functions/lib
git commit -m "feat(engine): the sleeve and the dip lane reach the board — famous names are candidates every day"
```

---

### Task 6: Never-blank board — grade C trades at half size, below-base stays visible

**Files:**
- Modify: `netlify/functions/lib/engine.ts:794-830` (flags + riskPct), `:867-877` (assembly)
- Modify: `src/components/EngineBoard.tsx` + `src/components/TodaysCalls.tsx` (copy: show half-size C rows as trades with their grade; keep the below-base "tape-dependent" label)
- Test: `netlify/functions/lib/engine.test.ts`

**Interfaces:**
- Produces: `Prediction.riskPct` may now be `RUNG_RISK_PCT[rung] / 2` for C-grade/contract-fail trades; `watchOnly` narrows to: below-base rows and C-rows beyond the per-side cap.

- [ ] **Step 1: Failing tests** (engine.test.ts, board-assembly section):

```ts
it('grade C with contract passes as a half-size trade', async () => {
  // fixture: calibration planted so the call grades C with evidence.contract true.
  // assert: row.watchOnly undefined, row.riskPct === RUNG_RISK_PCT[rung] / 2, instrument mapped.
})
it('a day with only C calls still publishes trades — the board is never blank', async () => {
  // fixture: all candidates grade C. assert trades (non-watchOnly rows) >= 1.
})
it('below-base rows stay visible as watch, never sized', async () => {
  // fixture: grade null + contract true (belowBase). assert watchOnly true, riskPct 0, belowBase true.
})
```

(As in Task 5: real tests in the file's harness style; the comments state the required assertions.)

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement in `engine.ts`:**

```ts
// Grade C with a passed contract is a HALF-SIZE trade, not a hidden row —
// "always show the best 1-3, honestly graded" (owner, 2026-08-11 spec §4.2).
// Below-base and thin-evidence stay watch-only; shadows unchanged.
const halfSize = !shadow && grade === 'C' && call.evidence.contract
const watchOnly = !shadow && !halfSize && (grade == null || !call.evidence.contract)
```

and in the pushed row: `riskPct: shadow || watchOnly ? 0 : halfSize ? RUNG_RISK_PCT[rung] / 2 : RUNG_RISK_PCT[rung]`. The `instrument` line's `grade!` stays valid (C is non-null). Assembly (867-877) needs no structural change — C rows now fall into `actionablePool` naturally; keep the 3/side cap and diversity gates exactly as-is, and C rows beyond the cap fall through to `watchPool`: change `watchPool` filter to `board.filter(b => !b.shadow && b.watchOnly)` plus, after `trades` are picked, re-flag unpicked actionable C rows as watch (`for (const b of actionablePool) if (!trades.includes(b) && b.riskPct < RUNG_RISK_PCT[b.riskRung]) { b.watchOnly = true; b.riskPct = 0; b.instrument = null }`).

- [ ] **Step 4: UI pass.** In `EngineBoard.tsx`/`TodaysCalls.tsx`, C-grade trades render in the trades section with their grade chip and "half size" on the risk line (both files already print `riskPct` — verify the copy reads naturally, e.g. "0.5% (half size — grade C)"). No layout rework.

- [ ] **Step 5: Full suite + `npm run build`** (tsc catches the Prediction typing). Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A netlify/functions/lib src
git commit -m "feat(board): never blank — grade C trades at half size, below-base stays visible"
```

---

### Task 7: Replay acceptance (ship gate)

**Files:**
- Modify (if needed): `scripts/engine-replay.ts` (read its usage header first; extend only to surface the new counters)
- Create: `docs/superpowers/plans/2026-08-11-stage1-replay-results.md` (the evidence)

- [ ] **Step 1:** Run the replay over the mirrored window: `npx tsx scripts/engine-replay.ts --from 2026-07-14 --to 2026-08-11` (match the script's real flags — check its header; if it replays single days, loop it).
- [ ] **Step 2:** Record in the results doc, per spec §5: (1) blank-board days before vs after (target: 0 after); (2) GLW present as a candidate on its post-earnings days and whether the dip lane tagged it; (3) ≥1 sleeve name reached a board; (4) grade distribution across the window (share of B; C-as-trade count); (5) win5/avg5 old vs new on the same window (no regression beyond noise).
- [ ] **Step 3:** If any criterion fails: STOP, write up the failure in the results doc, and bring it to the owner — do not tune thresholds to pass silently.
- [ ] **Step 4:** Commit the results doc. **Do not push any of Stage 1 until the owner has seen the replay results.**

```bash
git add docs/superpowers/plans/2026-08-11-stage1-replay-results.md scripts
git commit -m "test(replay): stage 1 acceptance evidence over the mirrored window"
```

---

## Self-Review Notes

- Spec coverage (§4.1 sleeve/losers/dip/capacity, §4.2 board bullet): Tasks 3+5 / 2 / 4+5 / 5(b)+6; replay gate = Task 7. Velocity, crypto, factor re-base, continuous probability, thesis/falsifier, learning: deliberately later stages.
- Type consistency: `SleeveRank`, `DipRead`, `sparkCloses`, `sleeve?: boolean`, `SLEEVE_CAPACITY_FLOOR`, `'dip'` tag — each defined once, consumed by name in Task 5/6.
- Known judgement calls for the implementer: exact fixture shapes in `engine.test.ts` must copy the file's existing harness (it stubs all deps); if `swingCapacity` import path differs (`shared/indicators.ts:60`), follow the real export; spark live shape may need the nested parser (Task 1 Step 5).
