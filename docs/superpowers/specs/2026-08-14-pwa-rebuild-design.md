# StreetSignal PWA Rebuild — Design Spec

**Date:** 2026-08-14 · **Status:** awaiting owner review · **Recon basis:** `.superpowers/sdd/ui-recon.md` (HEAD `293d314`)

The app is rebuilt as a fast, T212-feeling, local-first PWA that surfaces the engine's
learning machinery (funnel paths, convictions, regrets, post-mortems, gate learning) as the
product, with news demoted to one tab. Ships as ONE big-bang deploy replacing the current
shell. The paper/newsletter pipeline is untouched.

---

## 1. Ratified decisions

| # | Decision |
|---|---|
| D1 | **Approach A — local-first shell**: IndexedDB-cached slices, instant paint from cache + background refresh, real router with URLs, API split into views |
| D2 | Home = **Today stack** (sized call cards → counts rail → yesterday strip) |
| D3 | Board page = **conviction-ranked list** (calls → developing/watch → "the engine said no") |
| D4 | Stock page = **chart pinned top, verdict hero card below it**, then factors → funnel path → history, one scroll |
| D5 | Desktop ≥1200px = **master–detail desk** (rail + board column + ONE detail pane, one live chart ever mounted) |
| D6 | Visual style = **soft glass + indigo/royal blue** accents; bluish-white light theme (no cream); tabular numerals for all prices; green/red reserved exclusively for long/short & P&L |
| D7 | Nav = **Today · Stocks · Intel · Track record · More** |
| D8 | Stocks tab = T212 Discover pattern: search + vertical watchlist rows + **horizontal snap-scroll rails** (Top movers, Top losers, Sectors) each with See-all pages |
| D9 | **Ask is not a tab**: "Ask the desk" popup sheet on every stock page; searching any ticker triggers the on-demand engine verdict |
| D10 | **On-demand engine verdict** for unscanned names: real factor pipeline runs server-side on request; nullable factors shown honestly; LLM narrates only, never decides |
| D11 | **Removed entirely**: Journal, Positions, and ALL Trading 212 API integration (key management, sync, fetches; unused server endpoints retired at cutover) |
| D12 | **Big-bang cutover** in one deploy, gated by suite-green + headless phone & desktop walkthrough |
| D13 | Packaging waves: **wave 1 PWA** → **wave 2 macOS DMG** (Tauri, signed + notarised, built locally, no CI minutes) → **wave 3 Android APK** (Tauri, keystore-signed, sideload; no app stores) |
| D14 | The paper/newsletter compose pipeline is untouched; stored `Prediction` shape is untouched (crypto-pipeline terminal depends on it) |
| D15 | Rows are **asset-agnostic**: the shell renders whatever the board serves, so crypto names landing from the 1c pipeline need zero UI rework |

---

## 2. Architecture

Stack stays **Vite + React + TS**. New runtime dep: **wouter** (~2 KB router). Dexie already
present. No state library — the cache layer is the state. `motion` stays for transitions but
is confined to a lazy chunk if it can leave the entry path.

Three layers, strict one-way flow:

### 2.1 API slices (server)

`netlify/functions/engine.mts` gains `?view=` branches (rides the existing `/api/engine`
route — **no** router.ts/netlify.toml edits needed):

| View | Contents | Est. size | Notes |
|---|---|---|---|
| `?view=board` | board + intradayFlags + eventRadar + calibration.referenceBase + runStatus + riskState | ~17 KB | 2–3 store reads; what Today/Board need |
| `?view=journey&sym=` | per-name: today's funnel row + recent funnel path (last N days from `funnel-trace:*`), all past `predictions:*` rows for the symbol incl. `postMortem`, open-trace entry | ~5–15 KB | THE new HTTP door; projection drops `FactorScore.detail` from near-miss vectors |
| `?view=funnel&date=` | day's funnel trace, projected (rows + nearMisses minus factor `detail`) | ~15–20 KB | powers "the engine said no" |
| `?view=ledger` | 30-day ledger; `ledgerRow()` gains `postMortem` (one line) + `outcome21` | ~290 KB → paginate `days=7` default | Track record only consumer of full depth |
| `?view=verdict&sym=` | on-demand factor run for ANY symbol: candles fetched/cached, computable factors computed, null factors named, side lean + honest grade-or-ungraded | new handler ~5 KB | never writes to predictions; clearly labelled "on-demand, not a call" |
| `?view=learning` | structured `GateState` (full histories + bounds), missLedger with bounded `examples`, weights, scorecard, channelCred, roster | ~30 KB | powers Gates & learning + regrets |
| (no view) | legacy aggregate — kept during the build, **deleted at cutover** | 344 KB | |

Rules: every view respects the existing `auth.level` split (`holdingsReads` stays
admin/house-only); `cache-control` stays private; the miss-ledger "unchecked" caveat data
accompanies every gate-cost payload.

### 2.2 Local data layer (client)

One module (`src/lib/store.ts` + Dexie schema):

- Dexie tables: `slices` (key = view name + params, value + `fetchedAt`), `candles`
  (per symbol+range, TTL 900 s), `quotes` (TTL 120 s).
- One read-through primitive: `useSlice(view, params)` → returns `{data, fetchedAt, refreshing}`;
  paints cached immediately, revalidates in background (SWR), patches on arrival. Promise-level
  dedupe so concurrent consumers share one fetch.
- Screens NEVER call `fetch` directly. This replaces the nine uncoordinated `getEngine()`
  sites and the three module-level memos.
- All polls gated on `document.visibilityState`.
- IndexedDB name stays `momentumboard`; new tables added alongside the existing journal/
  watchlist tables (watchlist data is kept — Journal tables left in place but unused, NOT
  dropped, so nothing is destroyed).

### 2.3 Shell (client)

- **wouter** routes: `/app/` (Today) · `/app/board` · `/app/stocks` · `/app/stocks/movers` ·
  `/app/stocks/sectors` · `/app/stock/:sym` · `/app/intel` · `/app/record` (+ sub-anchors) ·
  `/app/more` · `/app/settings`. Browser back/forward and Android hardware back ride real
  history — the sentinel-entry back buffer dies.
- Deep links work; unknown routes redirect to `/app/`.
- Every screen lazy except Today; vendor `manualChunks` (react, react-dom, dexie, motion);
  chart vendor stays its own lazy chunk; `modulepreload` hints for the top routes.
- `key={syncTick}` full-app remount is removed; config sync patches state in place.
- Fonts self-hosted (woff2 in `public/fonts/`), Google Fonts `<link>` removed.
- The single global `index.css` is replaced by a fresh token-based stylesheet (see §5);
  inline styles avoided so the CSP can later be tightened.

---

## 3. Information architecture & screens

### 3.1 Today (`/app/`) — home
- Header: "Today" + regime pill (risk-on/off · tape adjective).
- 1–3 **sized call cards**: symbol + name, side (green/red), grade chip, conviction bar,
  sparkline, entry/stop/target, 🃏 with its warning where applicable, "sized half" note when true.
- Tap card → stock page.
- **Counts rail** (horizontal chips): Developing · n, Watch · n, Refused · n → each opens
  Board scrolled/filtered to that section.
- **Yesterday strip**: "2 wins · 1 stopped · biggest regret: PLTR +6.1%" → opens Track record.
- Empty state (no sized calls today): the board's honest "nothing sized today" copy —
  which must keep saying the same thing as the paper's board footnote (copy-consistency
  rule from `EngineBoard.tsx:325-336`).

### 3.2 Board (`/app/board`)
- One conviction-ranked scroll: sized calls (cards) → developing/watch (thin rows, conviction
  shown) → **"The engine said no"** (collapsed): every refusal today ranked by gate-free core
  conviction, each with a gate chip (25-code vocabulary rendered as human labels) and one-line
  detail. Near-miss/below-base rows NEVER show a letter grade or a real probability
  (invariant from `EngineBoard.tsx:70-85`).

### 3.3 Stocks (`/app/stocks`)
- Search (any ticker — resolves scanned or unscanned; unscanned → verdict flow).
- **Watchlist**: vertical T212 rows (avatar, name, price, change pill, sparkline). Add/remove kept.
- **Horizontal rails** (snap-scroll cards + See-all): Top movers · Top losers · Sectors
  (heatmap tiles; See-all = full heatmap page, day/week toggle, sector → constituents).

### 3.4 Stock page (`/app/stock/:sym`) — the journey page
Order (ratified): **chart pinned top** (with range pills) → **verdict hero card** ("Would the
engine trade it?" — side, grade or honest ungraded state, conviction, sizing note, stop/target
if called, gate chip + reason if refused) → **factor votes** (signed bars per factor, null
factors listed as "no data") → **funnel path** (today's gate outcome + recent day-by-day path)
→ **past calls** (each with outcome pill and post-mortem sentence) → open-trace verdict when a
call is live (still-on / intact / weakening + progress) → utilities: position calculator,
alert editor, small catalysts/news strip.
- **Ask the desk** button → popup sheet: LLM narration of the verdict, follow-up Q&A.
  Grounded in the engine payload; the LLM never contradicts or invents a verdict.
- Unscanned name: same page, verdict card labelled "on-demand read — not one of today's
  calls", funnel section replaced by "not in today's scan universe" + add-to-watchlist.

### 3.5 Intel (`/app/intel`)
- Today's paper at top (reader view + archive link), then news desk, then social pulse
  (YouTube/Reddit/StockTwits digests). News is deliberately secondary in the product; this
  tab is its only home.

### 3.6 Track record (`/app/record`)
- Scorecard stat tiles → calibration plot → **ledger as cards** (grouped by day; symbol, side,
  grade, outcome pill, post-mortem sentence; wildcard 🃏 marked; the 11-column sideways table
  is retired) → **Verdicts & regrets**: miss-ledger gate costs with named examples
  ("dead-zone refused PLTR on 4 Aug; it ran +6.1%"), each cost accompanied by the
  unchecked-count caveat.

### 3.7 More (`/app/more`)
- **Gates & learning**: gate-state timeline per tunable gate (value over time, bounds,
  cadence, owner pin visible), weights, roster, channel credibility.
- Research (aiRead/picks/dossiers, decrowded), Calendar, Settings.
- Settings loses every T212 row; keeps licence/admin, theme, install, BYOK.

### 3.8 Desktop (≥1200px)
- Master–detail: 5-item rail (collapsible) + board column (Board content) + detail pane
  hosting whichever page is active (stock page docked on row-click, Movers/Sectors/heatmap
  get the pane's full width). ONE live chart instance app-wide. Quant panels (Lean,
  Seasonality, SmartMoney, Learning) become an Analytics drawer inside the detail pane,
  desktop-only. The `mb-home`/Desk-vs-standard split dies — there is one desktop layout.

### 3.9 Removed / dissolved
- Screens deleted: Journal, Positions, Movers-as-screen, Intel-as-13-fetch-screen, Desk,
  Quant (content absorbed per above), TodaysCalls (already dead).
- Public site (`/`, `/engine`, `/paper`, `/ledger`, `/faq`), Landing, AppGate: kept as-is,
  restyled tokens only. Landing copy fix: remove the "Discord tracked" overclaim while touching it.
- T212: `src/lib` client code, Settings rows, and server endpoints retired at cutover.

---

## 4. Ask / on-demand verdict — mechanics

- `?view=verdict&sym=` : validates symbol, pulls candles via the existing market pipeline
  (cache store first), computes every factor that is computable from candles+cached context,
  returns `{side lean, core, computedFactors[], nullFactors[], gatesEvaluated, honest grade
  state, expectedMove if derivable}`. Marked `onDemand: true`; never persisted into
  `predictions:*`; never fed to calibration.
- Grade honesty: if the calibration bucket can't apply, the card says "no calibrated grade —
  technical read" rather than inventing a letter (mirrors the sized-like-it semantics rules).
- The Ask sheet sends the verdict payload + funnel/journey context to the existing LLM stack
  (Groq-first router, BYOK respected). LLM output is narration + Q&A only. Rate-limited
  client-side (one in flight; modest daily cap for non-admin) to protect free tiers.

---

## 5. Visual system

- **Tokens** (CSS custom properties, both themes):
  - Dark: midnight-indigo cast surfaces (`#151827` → `#10131f` gradients), hairline
    `rgba(150,160,255,0.10)` borders, text `#eef0f8`.
  - Light: white with lavender-blue wash (`#ffffff` → `#f0f1fb`), borders `#dfe1f2`,
    text `#1d2030`. No cream anywhere.
  - Accent: indigo `#5b6cf5` (dark) / `#4a5ae8` (light); conviction bars gradient
    `#a6b0ff → #5b6cf5` (dark) / `#8894fa → #4a5ae8` (light).
  - Long `#34c57f` (dark) / `#128a54` (light); short `#f87171` (dark) / `#c23a3a` (light) —
    used ONLY for side/P&L.
  - Grade chips: indigo pill gradient; 🃏 always carries its label + warning line.
- **Shape**: 20px card radius, soft shadows, pill chips/segments, blur-backed nav.
- **Type**: Inter (self-hosted); tabular numerals on every numeric; Fraunces stays for the
  brand "S" and paper masthead only.
- **Motion**: 150–200 ms push/pop route transitions with direction, press-scale on cards,
  skeletons shaped like content everywhere data can be stale-missing.
- Theme toggle persists; `prefers-color-scheme` default; PWA `theme_color` updated to match.

---

## 6. Performance budgets (hard gates at cutover)

| Metric | Budget | Today |
|---|---|---|
| Entry chunk (gzip) | ≤ 70 KB | 157.4 KB |
| Home warm paint (cache hit) | ≤ 300 ms | n/a (no cache) |
| Cold boot: requests before rows render | ≤ 4 parallel | 16 serial-ish |
| Serial request chains | 0 | 15 |
| `/api/engine` bytes for home | ≤ 20 KB | 344 KB |
| Full-app remounts per boot | 0 | 1 |
| Live charts mounted (desktop) | 1 | N per board |

Implementation levers: parallel candle fetches (quotes first), view slices, manualChunks,
lazy routes + modulepreload, memoised derivations, virtualised long lists (ledger, movers),
visibility-gated polls.

## 7. PWA / offline

- Precache: entry + CSS + fonts + icons only. Lazy chunks runtime-cached (CacheFirst).
- Runtime routes: NetworkFirst short-timeout for `board`/`quotes`; StaleWhileRevalidate for
  slow aggregates (sectors, movers, intel feeds, learning); CacheFirst+expiry for candles.
- **Update flow**: no unconditional `skipWaiting`; a "New version — reload" banner triggers it.
- **Offline**: header pill "offline — showing HH:MM data"; every screen renders its Dexie
  slice; failed refreshes surface as the pill, never silent `.catch(() => {})`.
- Manifest: same ids/scope (`/app/`), theme colours updated. **Never add `dist/404.html`.**

## 8. Packaging waves

- **Wave 1 (this spec's deploy): PWA** at thestreetsignal.rqai.co.uk.
- **Wave 2: macOS DMG** — Tauri v2 wraps the same `dist` (assets embedded in-binary; verify
  via `strings`, not Resources/ — Chapbook lesson), production API base, licence gate as web.
  Built, signed (Developer ID) and notarised **locally on this Mac**; zero CI minutes.
  No auto-update; new DMGs shipped manually.
- **Wave 3: Android APK** — Tauri Android target, new keystore (Chapbook signing pattern),
  sideload distribution only.

## 9. Constraints & invariants (do not regress)

1. Paper/compose pipeline untouched; stored `Prediction` shape untouched (crypto terminal).
2. Board empty-state copy ≡ paper board footnote (two surfaces, one sentence).
3. Near-miss / below-base / observation rows: no letter grade, no probability; the three
   unsized reasons keep their distinct sentences.
4. `scorecard.byGrade` keys include `shadow`/`wildcard` — never printed as "Grade shadow".
5. 🃏 label + warning on every surface where a wildcard renders.
6. Gate-cost figures always accompanied by the unchecked caveat.
7. `holdingsReads` and admin panels stay behind `auth.level`.
8. Licence gate flow (incl. 15-min fresh-token grace, `?key=` pre-mount consume) preserved.
9. Any brand-new `/api/*` route name needs router.ts + netlify.toml parity (avoided by
   riding `/api/engine?view=`).
10. IndexedDB name stays `momentumboard`; no destructive table drops.
11. Suite stays green (the 2,003/144 baseline recorded in the ui-recon HANDOFF — client
    tests will be rewritten alongside screens, so counts may change but failures stay zero).
12. Deploys are explicit: `npm run deploy:pages` / `deploy:cron`. No Co-Authored-By trailers
    in commits (repo rule).

## 10. Cutover plan & testing

1. Build behind the existing deploy-nothing default: all work on branch `pwa-rebuild`;
   production untouched until the gate passes.
2. Tests: unit tests per store-layer primitive and per screen (rewritten, not ported);
   server tests for each new `?view=` projection (auth split, size bounds, projection drops);
   the on-demand verdict gets fixture-based determinism tests.
3. **Pre-cutover gate** (all must pass, in order):
   a. Full suite green.
   b. Local production build + preview served; **headless walkthrough at 390×844 (phone) and
      1440×900 (desktop)**: every tab, Board incl. "engine said no", a stock page with
      journey + ask sheet, Track record, Intel, offline reload, licence gate, theme toggle —
      screenshots reviewed before deploy (Podium never-deploy-blind rule).
   c. Bundle budget check (§6 table) against the built `dist`.
4. Deploy `npm run deploy:pages`; immediately re-run the walkthrough against production;
   keep the previous deployment id noted for instant rollback.
5. Post-cutover: delete the legacy aggregate view + retired endpoints in a follow-up commit
   once the new shell has a clean day of production use.

## 11. Non-goals

- No engine/model changes; no stored-shape changes; no paper changes.
- No app stores, no auto-update in wrapped builds (wave 2/3 are manual distributions).
- No accounts/multi-user beyond the existing licence system.
- No news expansion — Intel is a containment tab, not a growth area.

## 12. Adjacent findings to action separately (not this build)

- `ledger-snapshot.mts` backup omits `miss-ledger`, `gate-state`, `funnel-trace:*` — surfacing
  them in the UI raises the cost of losing them; add to the snapshot list (server-side,
  5 lines, separate commit — coordinate with the crypto terminal).
- Supadata key rotation (leaked in chat 2026-07-23) still outstanding.
