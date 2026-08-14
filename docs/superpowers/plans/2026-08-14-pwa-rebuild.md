# StreetSignal PWA Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current app shell with a local-first, T212-feeling PWA (new IA, indigo soft-glass UI, real router, Dexie SWR cache, `?view=` API slices, funnel/regret surfaces) shipped as one big-bang deploy.

**Architecture:** Server first: `/api/engine` gains `?view=` slice branches (board/journey/funnel/ledger/learning/verdict) beside the legacy aggregate. Client second: a Dexie-backed `useSlice` read-through layer + wouter router + fresh token CSS replace the 14-variant View union; screens rebuild on that foundation; old screens/T212 integration are deleted at cutover behind a headless walkthrough + bundle-budget gate.

**Tech Stack:** Vite 5 + React 18 + TS 5.5, wouter (new, ~2 KB), Dexie 4 (present), lightweight-charts (present), vite-plugin-pwa/workbox (present), vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-14-pwa-rebuild-design.md` — read it before starting any task. Recon: `.superpowers/sdd/ui-recon.md`.

## Global Constraints

- Branch: ALL work on `pwa-rebuild`. Never deploy; deploys are explicit (`npm run deploy:pages`) and happen only at Task 27.
- Commits: conventional prefix, **NO Co-Authored-By trailer** (repo rule).
- The paper/compose pipeline and the stored `Prediction` shape are UNTOUCHED (a parallel terminal ships crypto work against them).
- No new `/api/*` route names — everything rides `/api/engine?view=` (router.ts + netlify.toml parity tests stay green untouched).
- `holdingsReads` and admin data stay behind `auth.level === 'admin' || auth.house`.
- Near-miss / below-base / observation rows: never a letter grade, never a probability. `scorecard.byGrade` keys include `shadow`/`wildcard` — never print "Grade shadow". 🃏 always renders with its label + warning. Gate costs always carry the unchecked caveat.
- Board empty-state copy must equal the paper's board footnote sentence (see `src/components/EngineBoard.tsx:325-336`).
- IndexedDB name stays `momentumboard` (`src/lib/db.ts`); additive schema only, no table drops.
- Colour semantics: green/red ONLY for long/short & P&L. Accent = indigo `#5b6cf5` (dark) / `#4a5ae8` (light). Light theme is bluish-white — no cream.
- Tabular numerals (`font-variant-numeric: tabular-nums`) on every numeric.
- **Never add `dist/404.html`.** Never edit `netlify.toml` `[[redirects]]`/`[[headers]]` without mirroring (`router.test.ts` / `hosting.test.ts` parse them).
- Suite green after every task: `npm test` (vitest run; fail = task not done).
- Budgets at cutover: entry chunk ≤ 70 KB gzip, 0 serial request chains, home warm paint from cache, exactly 1 live chart on desktop.

---

## Phase 1 — Server view slices (each independently shippable, zero UI risk)

### Task 1: Branch + `view` dispatcher + `?view=board`

**Files:**
- Modify: `netlify/functions/engine.mts` (dispatcher at top of the default handler, after `authenticate`)
- Test: `netlify/functions/engine.views.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/engine?view=board` → `{ ok, data: BoardSlice }` where
  `BoardSlice = { board, intradayFlags, eventRadar, runStatus, riskState, referenceBase: number|null }`
  (`board` = the full `engine-board` blob; `intradayFlags` only when `date` is today Europe/London — reuse the exact `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' })` guard already at `engine.mts:161`).
- Pattern all later view tasks copy: `const view = new URL(req.url).searchParams.get('view')`; each view does ONLY its own reads (board = 6, not 50) and returns via the existing `json()` helper. Unknown `view` → `json({ error: 'unknown view' }, 400)`. No `view` → legacy aggregate unchanged.

**Steps:**

- [ ] **Step 1:** `git checkout -b pwa-rebuild` (from up-to-date `main`; if the crypto terminal has pushed, pull first). Run `npm test` and record the baseline counts in the commit message of this task.
- [ ] **Step 2: Failing test.** Create `netlify/functions/engine.views.test.ts`. Mock the store + auth exactly like this (this mock block is shared by Tasks 1–6 — copy it, don't reinvent):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('./lib/storeProvider', () => ({
  appStore: {
    read: vi.fn(async (k: string) => store.get(k) ?? null),
    write: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
  },
}))
vi.mock('./lib/auth', () => ({
  authenticate: vi.fn(async () => ({ level: 'user', house: false })),
}))
import handler from './engine.mts'
import { authenticate } from './lib/auth'

const req = (qs = '') => new Request(`https://x/api/engine${qs}`, { headers: { 'x-app-token': 't' } })
const body = async (r: Response) => (await r.json()) as { ok: boolean; data: any }

beforeEach(() => { store.clear(); vi.mocked(authenticate).mockResolvedValue({ level: 'user', house: false } as any) })

describe('?view=board', () => {
  it('serves only the board slice, small', async () => {
    store.set('engine-board', { date: '2026-08-14', board: [{ sym: 'NVDA' }], regime: 'risk-on' })
    store.set('engine-calibration', { buckets: {}, brier: [], referenceBase: 0.41 })
    store.set('predictions:2026-08-14', [{ sym: 'SHOULD-NOT-APPEAR' }])
    const r = await body(await handler(req('?view=board')))
    expect(r.ok).toBe(true)
    expect(r.data.board.board[0].sym).toBe('NVDA')
    expect(r.data.referenceBase).toBe(0.41)
    expect(JSON.stringify(r.data)).not.toContain('SHOULD-NOT-APPEAR')
  })
  it('rejects unknown views', async () => {
    const res = await handler(req('?view=nope'))
    expect(res.status).toBe(400)
  })
  it('legacy aggregate still serves without view', async () => {
    store.set('engine-board', { date: '2026-08-14', board: [] })
    const r = await body(await handler(req()))
    expect(r.data).toHaveProperty('ledger')
    expect(r.data).toHaveProperty('missLedger')
  })
})
```

- [ ] **Step 3:** `npm test -- engine.views` → FAIL (unknown view returns aggregate today / board slice missing).
- [ ] **Step 4:** Implement in `engine.mts`: after the auth guard, insert the dispatcher; move the view handlers into named local functions (`viewBoard(auth)`, later `viewJourney(auth, sym)` …) so the file stays navigable. `viewBoard` reads exactly: `engine-board`, `intraday-flags`, `event-radar`, `engine-run-status`, `risk-state`, `engine-calibration` (project `referenceBase` only) in one `Promise.all`.
- [ ] **Step 5:** `npm test -- engine.views` → PASS, then full `npm test` → green.
- [ ] **Step 6:** Commit: `feat(api): engine ?view= dispatcher + board slice`.

### Task 2: `?view=journey&sym=`

**Files:**
- Modify: `netlify/functions/engine.mts`
- Test: `netlify/functions/engine.views.test.ts` (extend)

**Interfaces:**
- Consumes: `funnelTraceKey`, `FUNNEL_TRACE_INDEX_KEY` from `shared/engine/funnelTrace`; `ledgerRow` (same file).
- Produces: `{ sym, boardRow, openTrace, funnel: { date, row, nearMiss }[], calls: LedgerRowWithPM[] }`:
  - `funnel`: last **10** dates from `funnel-trace-index`; per date the trace rows whose key is `SYM`, `SYM:long` or `SYM:short` (use `traceRowKey`), plus the sym's `nearMisses` entry **with `factors[].detail` stripped** (project to `{score, weight}` — same projection `ledgerRow` uses).
  - `calls`: every prediction for the sym across the last **30** dates of `predictions-index`, as `ledgerRow(p)` **plus `postMortem: p.postMortem ?? null` and `outcome21: p.outcome21 ?? null`** (do NOT add these to `ledgerRow` itself yet — that is Task 3's change; here spread them on top).
  - `boardRow`: today's `engine-board` row for the sym or null. `openTrace`: the sym's entry from `open-trace` or null.
- Symbol param: uppercase, `[A-Z0-9.\-]{1,12}` else 400.

**Steps:**

- [ ] **Step 1: Failing tests** (extend the same file): (a) a sym with a funnel refusal on one date + a prediction on another returns both, factor `detail` absent from near-miss factors; (b) `?view=journey` without `sym` → 400; (c) sym unseen anywhere → `{ boardRow: null, funnel: [], calls: [] }` with `ok: true` (an empty journey is an answer, not an error).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `viewJourney`. **Step 4:** Run → PASS + full suite. **Step 5:** Commit `feat(api): journey view — the funnel's first HTTP door`.

### Task 3: `?view=ledger` + `ledgerRow` gains post-mortem

**Files:**
- Modify: `netlify/functions/engine.mts` (`ledgerRow` + new view)
- Test: `netlify/functions/engine.views.test.ts` (extend)

**Interfaces:**
- `ledgerRow` gains exactly two fields: `postMortem: p.postMortem` (the stored `{cls, detail, at, sentence?, clsBefore?, via?}` or undefined) and `outcome21: p.outcome21`. This is the "one line" the recon flagged (§3.3c) — the reader's history stops losing it. Update Task 2's journey code to now rely on plain `ledgerRow` (remove the spread).
- `?view=ledger&days=N` (N clamp 1..30, default 7): `{ days: { date, predictions: ledgerRow[] }[] }`, newest first — same shape as the aggregate's `ledger` key so `Track record` types are shared.

**Steps:**

- [ ] **Step 1: Failing tests:** (a) a prediction stored with `postMortem.cls='market-drag'` surfaces it through `view=ledger`; (b) `days=7` reads only 7 `predictions:*` keys (assert via the store mock's `read` call log); (c) legacy aggregate now also carries `postMortem` (it uses the same `ledgerRow`) — assert, and note the client `EngineData` type needs no change because extra fields are additive.
- [ ] **Step 2:** FAIL → implement → PASS → full suite → commit `feat(api): ledger view + postMortem/outcome21 ride ledgerRow`.

### Task 4: `?view=funnel&date=` (the "engine said no" feed)

**Files:**
- Modify: `netlify/functions/engine.mts`
- Test: `netlify/functions/engine.views.test.ts` (extend)

**Interfaces:**
- `?view=funnel` (optional `date=YYYY-MM-DD`, default = newest entry of `funnel-trace-index`): `{ date, gates, counts, emptySides, disabled, rows: [{ key, gate, side, source, detail, core, priorGate }] (sorted by core desc, nulls last), nearMisses: [{ sym, core, capUsdM, lastClose, capacityPct, stage, factors: {score,weight} }] }` — i.e. the stored `FunnelTrace` with `rows` flattened to an array and near-miss factor `detail` stripped (the ~85 %-of-bytes projection, recon §3.3a).
- Missing trace for the date → `{ date, rows: [], nearMisses: [], missing: true }`, 200.

**Steps:**

- [ ] **Step 1: Failing tests:** (a) default date resolves from the index tail; (b) rows sorted by `core` desc; (c) `factors.*.detail` absent; (d) missing day → `missing: true`.
- [ ] **Step 2:** FAIL → implement → PASS → suite → commit `feat(api): funnel view`.

### Task 5: `?view=learning` (structured gate state + regret examples)

**Files:**
- Modify: `shared/engine/gateState.ts` (add `gateStateStructured`), `shared/engine/missLedger.ts` (add `missLedgerExamples`), `netlify/functions/engine.mts`
- Test: `shared/engine/gateState.test.ts`, `shared/engine/missLedger.test.ts` (extend the modules' existing test files if present, else create), `netlify/functions/engine.views.test.ts`

**Interfaces:**
- `gateStateStructured(raw)` → `{ gates: { [gate]: { current, bounds: {min,max}, history: {date,from,to,why}[], blocked? } } }` — a pure projection of the stored blob (no new reads); keep `gateStateSummary` untouched (the paper + legacy panel keep using it).
- `missLedgerExamples(raw, topN = 8)` → `{ topGates: [{ gate, cost, saved, unchecked, causal?, examples: MissExample[] ≤ 10 }] , note }` — same maths as `missLedgerSummary` but keeps the examples and widens topN.
- `?view=learning` → `{ gateState: gateStateStructured(...), gateLines: gateStateSummary(...), regrets: missLedgerExamples(...), weights, scorecard, channelCred, roster, calibration }` (the last five projected exactly as the aggregate already projects them — lift those expressions into small helpers rather than duplicating).

**Steps:**

- [ ] **Step 1: Failing tests** for the two pure functions first (feed a hand-built blob; assert bounds/history survive and examples cap at 10), then the view test (regret example named in payload; unchecked count present).
- [ ] **Step 2:** FAIL → implement → PASS → suite → commit `feat(api+engine): learning view — structured gates + named regrets`.

### Task 6: `?view=verdict&sym=` (on-demand read)

**Files:**
- Create: `netlify/functions/lib/onDemandVerdict.ts`
- Modify: `netlify/functions/engine.mts`
- Test: `netlify/functions/lib/onDemandVerdict.test.ts`

**Interfaces:**
- `onDemandVerdict(sym: string, deps: { candles(sym: string): Promise<Candle[] | null> }): Promise<Verdict>` where
  `Verdict = { sym, onDemand: true, at: string, lean: 'long'|'short'|'none', core: number|null, computed: { name, score, weight }[], nulls: string[], stage: string|null, expectedMovePct: number|null, note: string }`.
- **Discovery step is part of this task:** read `netlify/functions/market.mts` and `netlify/functions/lib/engine.ts` to identify (a) the existing candle fetch+cache path used for `type=candles` and (b) the pure factor functions `buildBoard` calls to produce a candidate's core composite (`shared/engine/factors` / `composite`). `onDemandVerdict` must REUSE those pure functions — it re-implements nothing; it only assembles. Factors needing universe/social context return null and are listed in `nulls` by factor name.
- Honesty rules (test-enforced): never a `grade` or `probability` field; `note` always begins "On-demand read — not one of today's calls."; result is never written to any store key except a 15-minute cache entry `verdict-cache:{SYM}`.
- View wiring: `?view=verdict&sym=X` → run with a deps object built from the real candle path; 404-shaped `{ ok: true, data: { sym, unavailable: true } }` when candles can't be fetched.

**Steps:**

- [ ] **Step 1: Failing tests** with a fixture candle series (60 daily bars, trending): (a) lean/core computed deterministically (snapshot the numbers); (b) `nulls` names the context factors; (c) no `grade`/`probability` keys; (d) cache hit within 15 min (deps.candles called once across two invocations).
- [ ] **Step 2:** FAIL → discovery reading → implement → PASS → suite → commit `feat(api): on-demand verdict view`.
- [ ] **Step 3:** Measure real payload sizes: run `vite-node scripts/measure-views.ts` (write this tiny script: hit each view handler against `.d1/streetsignal.sqlite` via the existing script store path — pattern in `scripts/lib/httpD1.ts` consumers — and print gzip sizes). Record numbers in the commit body. Board must be ≤ 25 KB gzip-raw.

---

## Phase 2 — Client foundation (shell boots, no product screens yet)

### Task 7: Design tokens + fonts

**Files:**
- Create: `src/styles/tokens.css`, `src/styles/base.css`, `public/fonts/inter-var.woff2` (+ `fraunces-latin.woff2` if the masthead keeps it)
- Modify: `index.html` (drop the Google Fonts `<link>`s, add `<link rel="preload" as="font">`), `src/main.tsx` (import the two css files), `vite.config.ts` manifest `theme_color` → `#10131f`

**Interfaces (later tasks depend on these exact custom-property names):**

```css
:root[data-theme='dark'] {
  --bg: #0f1219; --surface-1: #151827; --surface-2: #10131f;
  --border: rgba(150,160,255,0.10); --text: #eef0f8; --text-dim: #a8aec6;
  --accent: #5b6cf5; --accent-soft: #a6b0ff;
  --long: #34c57f; --short: #f87171;
  --radius-card: 20px; --shadow-card: 0 8px 24px rgba(0,0,0,0.4);
}
:root[data-theme='light'] {
  --bg: #f6f7fc; --surface-1: #ffffff; --surface-2: #f0f1fb;
  --border: #dfe1f2; --text: #1d2030; --text-dim: #666c85;
  --accent: #4a5ae8; --accent-soft: #8894fa;
  --long: #128a54; --short: #c23a3a;
  --radius-card: 20px; --shadow-card: 0 8px 20px rgba(80,90,200,0.10);
}
```

`base.css`: reset, `body { background: var(--bg); color: var(--text); font-family: Inter, ... }`, `.num { font-variant-numeric: tabular-nums }`, card/pill/segment/skeleton primitives (`.card`, `.pill`, `.seg`, `.skeleton`) styled per the ratified soft-glass mockups (`.superpowers/brainstorm/67693-1786687483/content/style-direction-v2.html`, option B = indigo, IS the visual reference — open it while writing this CSS).

**Steps:**

- [ ] **Step 1:** Download Inter var latin woff2 (fontsource or Google Fonts static URL) into `public/fonts/`; failing test first: extend `src/theme.test.ts` (create) asserting `index.html` contains no `fonts.googleapis.com` and that `tokens.css` defines `--accent` in both theme blocks (read files with `fs` in the test — cheap and honest).
- [ ] **Step 2:** FAIL → implement → PASS. Keep the theme-boot inline script behaviour (`index.html:14-23`) but write `data-theme` on `<html>` (both `dark`/`light` explicit; migrate the old storage key it reads).
- [ ] **Step 3:** `npm run build` still green (old `index.css` untouched and still loaded — the old shell must keep working until Task 24). Commit `feat(ui): token system + self-hosted fonts`.

### Task 8: Dexie slice store + `useSlice`

**Files:**
- Create: `src/lib/store.ts`, `src/lib/useSlice.ts`
- Modify: `src/lib/db.ts` (version bump: `slices` table `&key, fetchedAt`)
- Test: `src/lib/store.test.ts`, `src/lib/useSlice.test.tsx`

**Interfaces:**

```ts
// store.ts
export type SliceKey = `board` | `journey:${string}` | `funnel:${string}` | `ledger:${number}`
  | `learning` | `verdict:${string}` | `movers` | `sectors` | `quotes:${string}` | `intel` | `reports`
export interface SliceRecord<T = unknown> { key: string; data: T; fetchedAt: number }
export const SLICE_TTL: Record<string, number> = { board: 120_000, quotes: 120_000, movers: 300_000, default: 900_000 }
export async function readSlice<T>(key: SliceKey): Promise<SliceRecord<T> | null>
export async function writeSlice<T>(key: SliceKey, data: T): Promise<void>
/** SWR: resolve cached immediately via onCached, fetch when stale, dedupe in-flight. */
export function fetchSlice<T>(key: SliceKey, fetcher: () => Promise<T>, opts?: { force?: boolean }): Promise<T>
// useSlice.ts
export function useSlice<T>(key: SliceKey, fetcher: () => Promise<T>): {
  data: T | null; fetchedAt: number | null; refreshing: boolean; offline: boolean; refresh(): void }
```

- In-flight dedupe is a module-level `Map<string, Promise>`. `offline` flips when a refresh rejects with a network error while cache exists. Poll-free: consumers re-render on window `focus`/`visibilitychange` → `refresh()` if stale (test this).

**Steps:**

- [ ] **Step 1: Failing tests:** (a) `fetchSlice` returns cache then patches (fetcher resolves later value; onCached order asserted); (b) two concurrent `fetchSlice('board')` → fetcher called once; (c) TTL: fresh cache short-circuits the fetcher; (d) `useSlice` (renderHook) paints cached, sets `refreshing` true→false, `offline` on rejection with cache present. Use `fake-indexeddb` — add as devDependency (`npm i -D fake-indexeddb`) and wire in `src/test-setup.ts`.
- [ ] **Step 2:** FAIL → implement → PASS → suite → commit `feat(client): dexie slice store + useSlice SWR hook`.

### Task 9: Typed view client

**Files:**
- Create: `src/lib/apiViews.ts`
- Test: `src/lib/apiViews.test.ts`

**Interfaces:**
- Re-export `apiGet` from `src/lib/api.ts` (the token header logic stays in ONE place). Typed getters, one per view, each returning the exact server shapes from Phase 1: `getBoardSlice()`, `getJourney(sym)`, `getFunnel(date?)`, `getLedgerDays(days)`, `getLearning()`, `getVerdict(sym)` — plus `getQuotes(symbols)`, `getMovers()`, `getSectors()` delegating to existing `api.ts` functions. Types live here (`BoardSlice`, `JourneySlice`, `FunnelSlice`, `LearningSlice`, `Verdict`, `LedgerDay`) — imported by every screen; mirror server fields 1:1 and import `GateCode` from `shared/engine/types` (precedent: `api.ts:4-5`).

**Steps:**

- [ ] **Step 1: Failing test:** mock `fetch`; assert `getJourney('nvda')` hits `/api/engine?view=journey&sym=NVDA` (uppercase) with `x-app-token`, and unwraps `{ok,data}`.
- [ ] **Step 2:** FAIL → implement → PASS → commit `feat(client): typed view client`.

### Task 10: Router shell + nav

**Files:**
- Create: `src/shell/AppShell.tsx`, `src/shell/Nav.tsx`, `src/shell/routes.ts`, `src/shell/Screen.tsx` (transition wrapper)
- Modify: `src/App.tsx` (mount `AppShell` behind a `localStorage['mb-shell']==='v2'` flag — the old shell remains default until Task 24 flips it), `src/main.tsx` (nothing — licence `?key=` consume at `main.tsx:9-21` stays)
- Test: `src/shell/AppShell.test.tsx`

**Interfaces:**

```ts
// routes.ts
export const ROUTES = [
  { path: '/',            key: 'today',  label: 'Today',        lazy: () => import('../screens2/Today') },
  { path: '/board',       key: 'board',  label: 'Board',        lazy: () => import('../screens2/Board') },
  { path: '/stocks',      key: 'stocks', label: 'Stocks',       lazy: () => import('../screens2/Stocks') },
  { path: '/stocks/movers',  key: 'stocks', lazy: () => import('../screens2/Movers') },
  { path: '/stocks/sectors', key: 'stocks', lazy: () => import('../screens2/Sectors') },
  { path: '/stock/:sym',  key: 'stocks', lazy: () => import('../screens2/StockPage') },
  { path: '/intel',       key: 'intel',  label: 'Intel',        lazy: () => import('../screens2/Intel') },
  { path: '/record',      key: 'record', label: 'Track record', lazy: () => import('../screens2/Record') },
  { path: '/more',        key: 'more',   label: 'More',         lazy: () => import('../screens2/More') },
  { path: '/settings',    key: 'more',   lazy: () => import('../screens2/Settings') },
] as const
```

- `AppShell`: `<Router base="/app">`, `Suspense` fallback = skeleton page, licence gate = reuse the existing check from `src/App.tsx:80-94` (extract it to `src/lib/licence.ts` unchanged — mount-only, 15-min grace preserved, move its test coverage along). New screens live in `src/screens2/` until cutover renames.
- `Nav`: bottom tab bar < 1024 px, left rail ≥ 1024 px (CSS only, like the old `TabBar` — see `src/index.css:9-13` warning), 5 entries from `ROUTES` where `label` present, active = `key` match on current path.
- `Screen`: 160 ms directional slide (motion), direction = route depth delta. Placeholder `screens2/*` stubs render `<h1>{name}</h1>` for now.
- No `key={syncTick}` anywhere in the new tree; `src/lib/sync.ts` change events patch Dexie slices instead (wire in Task 12).

**Steps:**

- [ ] **Step 1: Failing tests:** (a) `/app/stock/NVDA` renders the StockPage stub with param; (b) nav shows 5 labels; (c) browser back from stock → previous route (use memory location from wouter for tests); (d) unlicensed → gate screen renders (mock `licence.ts`).
- [ ] **Step 2:** FAIL → implement → PASS → suite → manual smoke: `npm run dev`, visit `http://localhost:5173/app/?shell=v2` (flag setter in Settings later; for dev, `localStorage.setItem('mb-shell','v2')` in the console). Commit `feat(shell): wouter router + 5-tab nav behind mb-shell flag`.

### Task 11: Build discipline — chunks, lazy, budgets

**Files:**
- Modify: `vite.config.ts`
- Create: `scripts/check-budgets.mjs`
- Test: budget script IS the test (runs in CI/`npm test` posture via a `test` step here; wire into `package.json` as `"budget": "node scripts/check-budgets.mjs"`)

**Steps:**

- [ ] **Step 1:** Add to `vite.config.ts`: `build.rollupOptions.output.manualChunks = { react: ['react','react-dom'], data: ['dexie'], motion: ['motion'] }` and `build.target = 'es2022'`.
- [ ] **Step 2:** `scripts/check-budgets.mjs`: after `npm run build`, gzip-measure `dist/assets/*`; FAIL (exit 1) if entry > 70 KB gzip **once Task 24 has flipped the shell** — until then it prints a table and warns (flag `--enforce`). Print per-chunk sizes sorted.
- [ ] **Step 3:** `npm run build && node scripts/check-budgets.mjs` — record the table in the commit body. Commit `chore(build): manualChunks + budget gate`.

### Task 12: Service worker + offline/update UX

**Files:**
- Modify: `src/sw.ts`, `vite.config.ts` (`injectManifest.globPatterns` → `['index.html','assets/index-*.{js,css}','fonts/*.woff2','icon*.{png,svg}','manifest.webmanifest']`), `src/shell/AppShell.tsx`
- Create: `src/shell/UpdateBanner.tsx`, `src/shell/OfflinePill.tsx`
- Test: `src/shell/UpdateBanner.test.tsx`; `src/sw.test.ts` (route-config unit: export the route table from sw.ts as data and assert classes)

**Interfaces:**
- `src/sw.ts`: remove top-level `skipWaiting()`; add `message` listener for `{type:'SKIP_WAITING'}`. Runtime routes (workbox): NetworkFirst(3 s timeout) for `\/api\/engine\?view=(board|verdict)` and `market\?type=quote`; StaleWhileRevalidate for `view=(funnel|ledger|learning|journey)` + movers/sectors/intel endpoints; CacheFirst + `ExpirationPlugin({maxAgeSeconds: 900, maxEntries: 60})` for candles. Keep push/notificationclick handlers verbatim (`src/sw.ts:21-50`).
- `vite.config.ts`: `registerType: 'prompt'`. `UpdateBanner` uses `virtual:pwa-register`'s `useRegisterSW` → "New version — Reload" → `updateServiceWorker(true)`.
- `OfflinePill` renders when any mounted `useSlice` reports `offline` (context set by AppShell) → "offline — showing HH:MM data" from oldest mounted `fetchedAt`.

**Steps:**

- [ ] **Step 1: Failing tests** (banner renders on `needRefresh`, pill formats the stamp) → **Step 2** implement → PASS → suite → `npm run build` and eyeball `dist/sw.js` precache count (< 10 entries). Commit `feat(pwa): trimmed precache, runtime caching, prompt update, offline pill`.

---

## Phase 3 — Screens (every task: styles from tokens only; every fetch via useSlice; every numeric `.num`; skeletons shaped like content; each screen file ≤ ~250 lines — split subcomponents into `src/screens2/parts/`)

**Shared visual reference for ALL Phase-3 tasks:** the ratified mockups — `home-layout.html` (option A), `journey-layout.html` (B modified: chart top), `desktop-layout.html` (A), `style-direction-v2.html` (B indigo) in `.superpowers/brainstorm/67693-1786687483/content/`.

### Task 13: Today

**Files:** Create `src/screens2/Today.tsx`, `src/screens2/parts/CallCard.tsx`, `src/screens2/parts/CountsRail.tsx`, `src/screens2/parts/YesterdayStrip.tsx`; Test `src/screens2/Today.test.tsx`

**Interfaces:**
- Data: `useSlice('board', getBoardSlice)` + `useSlice('ledger:2', () => getLedgerDays(2))` (yesterday strip).
- `CallCard({ row })`: symbol+name, side word in `--long/--short`, grade pill (ONLY when `row.grade` exists and row is sized/live — never for nearMiss/observation/watch), conviction bar (`row.composite` normalised), sparkline (reuse `src/components/Sparkline.tsx`), entry/stop/target `.num`, 🃏 + `WILDCARD_LABEL`/`WILDCARD_WARNING` from `shared/engine/voice` when `row.wildcard`, sizing note. Click → `navigate('/stock/'+sym)`.
- `CountsRail`: chips Developing/Watch/Refused with counts (developing+watch from board rows by stage; refused count from `boardRow.emptySides`-adjacent — fetch `funnel` slice lazily ONLY for the count via `useSlice('funnel:latest', ...)`, render chip without count until it arrives). Chips navigate `/board#developing` etc.
- `YesterdayStrip`: from yesterday's ledger day: wins/stopped counts + biggest `postMortem`-carrying loser or biggest regret if `learning` slice already cached (do NOT fetch learning here).
- Empty state: exact board-footnote sentence — import/copy the string constant; add a comment pointing at `EngineBoard.tsx:325-336` + `newspaper.ts` `boardFootnote`.

**Steps:**

- [ ] **Step 1: Failing tests:** (a) renders call card for a sized row w/ grade; (b) near-miss row: no grade chip, no probability text; (c) wildcard row shows label+warning; (d) empty board shows the footnote sentence; (e) cached slice paints without awaiting fetch (fetcher never resolves in test — data from seeded Dexie).
- [ ] **Step 2:** FAIL → implement → PASS → suite → commit `feat(screens): Today`.

### Task 14: Board

**Files:** Create `src/screens2/Board.tsx`, `src/screens2/parts/RefusalRow.tsx`; Test `src/screens2/Board.test.tsx`

**Interfaces:**
- Sections in one scroll: sized (CallCards) → developing/watch (thin rows: sym, side, stage, conviction `.num`) → "The engine said no" (collapsed `<details>`, opens via `#refused` anchor): `useSlice('funnel:latest', () => getFunnel())`, rows ranked by `core` desc, `RefusalRow` = sym, side, human gate label + `detail`, core. Gate label map: create `src/lib/gateLabels.ts` — all 25 codes from `shared/engine/types` `GateCode` → short human phrases (e.g. `dead-zone-core: 'below the conviction bar'`, `entry-chase: 'already ran — refused to chase'`, `slot-cut: 'lost the last slot'`); export and exhaustively test against the union (a `satisfies Record<GateCode, string>` makes missing codes a type error).
- No letter grades or probabilities anywhere in refusals.

**Steps:** failing tests (ranking order, gate label exhaustiveness, anchor opens section) → implement → PASS → commit `feat(screens): Board + engine-said-no`.

### Task 15: Stocks (watchlist + rails)

**Files:** Create `src/screens2/Stocks.tsx`, `src/screens2/parts/StockRow.tsx`, `src/screens2/parts/HRail.tsx`; Test `src/screens2/Stocks.test.tsx`

**Interfaces:**
- Search box: on submit `[A-Za-z0-9.\-]{1,12}` → navigate `/stock/SYM` (uppercase).
- Watchlist: rows from existing Dexie `db.watchlist` (keep `src/lib/starter.ts` seeding); quotes via ONE `useSlice('quotes:<joined>', ...)` batch call; candle sparklines via a `Promise.all` batch (port the fix, not the code, of `useMarketData` — the serial loop dies here); add/remove kept.
- `HRail({ title, seeAllPath, children })`: horizontal snap-scroll (`scroll-snap-type: x mandatory`), used for Top movers / Top losers / Sectors tiles; each rail's data lazy-loads when scrolled into view (IntersectionObserver) — boot cost 0.
- `StockRow`: avatar (reuse `symbolHue` from `src/components/TickerRow.tsx`), name, price, change pill, sparkline.

**Steps:** failing tests (search navigates uppercase; rails lazy — fetcher not called until observed (mock IO); watchlist rows render from seeded Dexie) → implement → PASS → commit `feat(screens): Stocks with T212 rails`.

### Task 16: Movers + Sectors see-all pages

**Files:** Create `src/screens2/Movers.tsx`, `src/screens2/Sectors.tsx`; Test one file `src/screens2/MoversSectors.test.tsx`

- Movers: gainers/losers `.seg` toggle, full StockRow list, virtualise past 40 rows (simple windowing: render slice on scroll — no new dependency). Sectors: tile grid, day/week toggle, colour scale from `--long`/`--short` at 4 alpha stops (NEVER a third hue), tap → filtered movers list → StockPage.
- Steps: failing tests (toggle switches list; sector tap filters) → implement → PASS → commit.

### Task 17: StockPage (the journey page)

**Files:** Create `src/screens2/StockPage.tsx`, `src/screens2/parts/VerdictHero.tsx`, `src/screens2/parts/FactorVotes.tsx`, `src/screens2/parts/FunnelPath.tsx`, `src/screens2/parts/PastCalls.tsx`; Test `src/screens2/StockPage.test.tsx`

**Interfaces:**
- Order (ratified): chart (lazy `PriceChart` chunk, range pills) → `VerdictHero` → `FactorVotes` → `FunnelPath` → `PastCalls` → open-trace verdict card when present → utilities (reuse `PositionCalculator`, `AlertEditor` from old components restyled) → catalysts strip (existing news brief endpoint, 3 items max).
- Data: `useSlice('journey:SYM', () => getJourney(sym))`; if `boardRow == null && calls.length === 0 && funnel.length === 0` → fetch `useSlice('verdict:SYM', () => getVerdict(sym))` and render the on-demand variant.
- `VerdictHero({ journey | verdict })`: called → side, grade pill, conviction, sizing note, stop/target; refused → gate label + detail + core ("conviction it would have had"); on-demand → the `note` honesty line + lean + computed factor count + "not calibrated" instead of a grade. NEVER render grade/probability for refused/on-demand.
- `FactorVotes`: signed horizontal bars from centre (pos → `--long`-tinted accent? NO — bars use `--accent` scale; only the side word uses long/short colours), `nulls` listed as "no data: news tone, social".
- `FunnelPath`: vertical dated steps, dot colour: published=accent, refused=amber `#f0a35e` (add `--warn` token in Task 7 — update tokens then), absent=dim.
- `PastCalls`: ledger-row cards w/ outcome pill (`outcome10`/`outcome21` pct `.num`) + `postMortem.sentence ?? postMortem.detail` italic line.

**Steps:** failing tests: (a) scanned sym renders all five sections in DOM order; (b) refused-today sym: hero shows gate label, no grade; (c) unscanned sym falls through to verdict variant with honesty note; (d) wildcard past call renders 🃏+warning → implement → PASS → commit `feat(screens): StockPage journey`.

### Task 18: Ask sheet

**Files:** Create `src/screens2/parts/AskSheet.tsx`; Modify `src/screens2/StockPage.tsx` (button + mount); Test `src/screens2/AskSheet.test.tsx`

- Bottom sheet (motion slide-up, `role="dialog"`, Esc/scrim closes). Reuses the ask flow from `src/components/AskDesk.tsx` (`api.ts` ask function) but ALWAYS prefixes the request context with the journey/verdict payload summary; renders answer + follow-up input; one in-flight at a time; non-admin soft cap 20/day (localStorage counter, friendly copy when hit).
- Steps: failing tests (opens/closes; context includes verdict summary; cap message at 20) → implement → PASS → commit.

### Task 19: Intel

**Files:** Create `src/screens2/Intel.tsx`; Test `src/screens2/Intel.test.tsx`

- Three stacked sections, each its own `useSlice` + skeleton, no 13-fetch mount: Today's paper (existing report list/read endpoints from `api.ts` — latest edition inline reader + archive link), News desk (existing `news-desk` endpoint), Social pulse (trending/social endpoints). Feeds virtualised past 30 items. This is news's ONLY home (spec §3.5).
- Steps: failing tests (three sections render independently — one slice erroring doesn't blank the others) → implement → PASS → commit.

### Task 20: Track record

**Files:** Create `src/screens2/Record.tsx`, `src/screens2/parts/LedgerDayCards.tsx`, `src/screens2/parts/Regrets.tsx`; Test `src/screens2/Record.test.tsx`

- Order: scorecard stat tiles (byGrade — filter `shadow`/`wildcard` into their OWN labelled tiles, never "Grade shadow") → `CalibrationPlot` (reuse component, restyle) → ledger day cards (`useSlice('ledger:7', ...)`, "Load 30 days" button swaps slice) → `Regrets` from `useSlice('learning', ...)`: per top gate — human label, cost pp, saved pp, `causal` when present, named examples ("dead-zone refused PLTR · 04 Aug · ran +6.1pp"), and the unchecked caveat line rendered whenever `unchecked > 0` (constraint: caveat is not optional).
- Steps: failing tests (shadow/wildcard tiles labelled correctly; regret example renders sym+date+pp; caveat present when unchecked>0; postMortem sentence on loser card) → implement → PASS → commit `feat(screens): Track record + regrets`.

### Task 21: More + Gates & learning + Settings v2

**Files:** Create `src/screens2/More.tsx`, `src/screens2/GatesLearning.tsx`, `src/screens2/Settings.tsx`; Test `src/screens2/GatesLearning.test.tsx`, `src/screens2/Settings.test.tsx`

- More: menu groups (Gates & learning / Research / Calendar / Settings) + theme toggle + install row (reuse `installPrompt.ts`). Research + Calendar: keep OLD screens mounted via lazy routes `/more/research`, `/more/calendar` (add to ROUTES; they render inside the new shell untouched — restyle is out of scope).
- GatesLearning: per tunable gate from `learning.gateState.gates`: name, current value vs bounds (mini bar), history timeline (date, from→to, why), `blocked` note; then weights (base vs current bars), roster, channel cred table.
- Settings v2: port licence/admin/BYOK/notifications rows from `SettingsScreen.tsx`; **omit every T212 row**; add theme + shell-flag row.
- Steps: failing tests (gate history renders bounds; Settings contains no "212" string — literal assertion) → implement → PASS → commit.

### Task 22: Desktop master–detail

**Files:** Create `src/shell/DeskLayout.tsx`; Modify `src/shell/AppShell.tsx`, `src/screens2/*` (none structurally — pages render into the pane); Test `src/shell/DeskLayout.test.tsx`

- ≥ 1200 px: grid `[rail 216px | board-col 320px | detail 1fr]`. Board column = `Board` content; detail pane = routed page (StockPage on row click — row click navigates, layout persists). Movers/Sectors/Intel/Record take the detail pane full-width. ONE `PriceChart` instance app-wide (the pane's). Analytics drawer: lazy mount of the four quant panels (`LeanPanel`, `SeasonalityPanel`, `SmartMoneyPanel`, `LearningPanel`) in a right slide-over, desktop only.
- Below 1200 px nothing changes (bottom tabs). The old Desk/Quant screens are NOT routed in the new shell.
- Steps: failing tests (at 1440 px matchMedia mock: three columns render, StockPage in pane; at 390 px: tabs) → implement → PASS → commit `feat(shell): desktop master-detail`.

---

## Phase 4 — Cutover

### Task 23: The walkthrough harness (BEFORE the flip — it must pass against the flag first)

**Files:** Create `scripts/walkthrough.mjs`; Modify `package.json` (`"walkthrough": "node scripts/walkthrough.mjs"`)

- Pattern: the repo's proven CDP script approach (see memory note: `cdp.mjs` E2E pattern, 2026-07-15) — plain `chrome --headless=new --remote-debugging-port` + CDP over websocket, no new deps. Serve `dist` via `npm run preview`. Script sets `localStorage['mb-shell']='v2'` + a test licence token, then walks: `/app/` (Today) → `/app/board` (+ open refused) → `/app/stocks` → `/app/stock/NVDA` → ask sheet open → `/app/intel` → `/app/record` → `/app/more` → theme toggle → offline reload (`Network.emulateNetworkConditions offline`) asserting the offline pill + cached board, at **390×844** then **1440×900** (desk: assert 3 columns + row-click swaps pane). Screenshot each stop to `.superpowers/walkthrough/<viewport>-<stop>.png`; exit non-zero on any console error or failed assertion.
- Steps: write script → run against the built flag-on shell → fix what it catches → commit `test(e2e): headless walkthrough harness`.

### Task 24: The flip + removals

**Files:**
- Modify: `src/App.tsx` (new shell becomes THE shell; `mb-shell` flag removed), `src/main.tsx`
- Delete: `src/screens/Watchlist.tsx`, `Intel.tsx`, `TickerDetail.tsx`, `Journal.tsx`, `More.tsx`, `Movers.tsx`, `Positions.tsx`, `Desk.tsx`, `Quant.tsx`, `Ledger.tsx`, `Reports.tsx` (Reports content reachable from Intel), `src/components/TodaysCalls.tsx`, `src/components/EngineBoard.tsx`, `EnginePanel.tsx`, old `TabBar.tsx`, their tests, `src/hooks/useMarketData.ts`, T212 client code (`src/lib` t212 functions + `api.ts` t212 getters), the `key={syncTick}` remount, dead CSS from `src/index.css` (delete the file once nothing imports it — `SitePages`/`Landing` styles move to `src/styles/site.css` verbatim)
- Modify: `src/screens/SitePages.tsx`, `Landing.tsx` (retoken only + fix the "Discord…tracked" overclaim line), `netlify/functions/` t212 endpoints → delete + remove their route entries **in BOTH `router.ts` EXACT_ROUTES and `netlify.toml` [[redirects]]** (parity tests enforce), keep `/api/engine` legacy aggregate for one release.
- Test: full suite rewrite fallout — delete tests of deleted files; `npm test` green is the gate.

**Steps:**

- [ ] **Step 1:** Flip + delete in ONE commit series (flip commit, then deletion commits per area so bisect stays sane). After each: `npm test`.
- [ ] **Step 2:** `npm run build && node scripts/check-budgets.mjs --enforce` → entry ≤ 70 KB gzip or STOP and split further.
- [ ] **Step 3:** `npm run walkthrough` (both viewports) → all green, review screenshots by eye.
- [ ] **Step 4:** Commit `feat!: cutover to v2 shell`.

### Task 25: Deploy + verify + rollback note

- [ ] **Step 1:** `wrangler pages deployment list` → record current deployment id (rollback target) in `.superpowers/sdd/cutover-log.md`.
- [ ] **Step 2:** **CONFIRM WITH OWNER in-session, then** `npm run deploy:pages`.
- [ ] **Step 3:** Re-run `scripts/walkthrough.mjs` against `https://thestreetsignal.rqai.co.uk` (real licence key from owner's device — coordinate; or house token). Check the paper still composed that morning (untouched pipeline, but verify reader-facing `/paper` renders).
- [ ] **Step 4:** Update memory + `.superpowers/sdd/progress.md`. Commit docs.

### Task 26 (follow-up, next session): legacy cleanup

- Delete the no-view aggregate branch from `engine.mts` + the old `EngineData` client type once production has one clean day; add `miss-ledger`, `gate-state`, `funnel-trace:*` to `ledger-snapshot.mts` (coordinate with crypto terminal — server file they may touch).

---

## Waves 2/3 (separate plans, after wave 1 ships)

- **DMG:** Tauri v2 wrap of `dist` (assets in-binary — verify via `strings`, Chapbook lesson), Developer ID signing + notarisation, LOCAL build only. **APK:** Tauri Android + new keystore, sideload. Each gets its own plan doc when scheduled.

## Self-review notes (author)

- Spec coverage: §2.1→Tasks 1-6, §2.2→8, §2.3→7/10/11, §3.1-3.8→13-22, §4→6/18, §5→7, §6→11/24, §7→12, §10→23-25, §3.9/removals→24. Waves 2/3 §8 deferred by design. Landing copy fix §3.9 → Task 24. Adjacent findings §12 → Task 26.
- Types: `SliceKey` strings in Tasks 8/13-21 match; view names match Phase 1 exactly; `screens2/` paths consistent; `--warn` token added in Task 17 (amend tokens.css there).
