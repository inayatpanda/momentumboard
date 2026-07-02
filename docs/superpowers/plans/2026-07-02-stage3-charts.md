# MomentumBoard Stage 3 — Charts + Position Calculator Implementation Plan

> Executed inline. Lean format (interfaces + test cases; code at implementation). TDD per logic module; UI verified in-browser; ONE batched CLI deploy at the end (user's deploy preference).

**Goal:** Tap a watchlist ticker → full detail screen: candlestick chart with volume and 20/50/200 MAs, RSI(14) panel, range switcher (3M/6M/1Y), setup badges, the alert editor (moves here from the watchlist), per-ticker news, and a position-size calculator enforcing the risk defaults (2% / 1% speculative, 20% position cap).

**Spec:** §4.3 screen 2, §5 sizing. Library: `lightweight-charts@^4.2` (pinned v4 API).

## Tasks

### T1: `shared/risk.ts` — position sizing (TDD)
```ts
export interface SizeInput { capital: number; riskPct: number; entry: number; stop: number; riskClass: 'normal' | 'speculative' }
export interface SizeResult { riskAmount: number; perUnitRisk: number; units: number; positionValue: number; positionPctOfCapital: number; warnings: string[] }
export function positionSize(i: SizeInput): SizeResult | null // null when entry<=0, stop<=0, or stop===entry
```
Rules: speculative halves riskPct; `units = floor(riskAmount / |entry-stop|)`; warnings when positionValue > 20% of capital ("exceeds 20% position cap — size shown is capped", and CAP the units to 20%), when stop is on the wrong side of entry for a long (stop>entry ⇒ treat as short note), when perUnitRisk < 0.1% of entry ("stop too tight — noise will hit it").
Tests: normal long (5000 capital, 2%, entry 100, stop 95 → risk £100, 20 units, £2000... that's 40% → capped to 10 units £1000 with warning); speculative halves to £50; null on invalid; tight-stop warning.

### T2: `src/lib/chartData.ts` — pure transforms (TDD)
```ts
export function toCandleSeries(candles: Candle[]): { time: UTCTimestamp; open; high; low; close }[]
export function toVolumeSeries(candles: Candle[]): { time; value; color }[] // green up / red down bars
export function toLineSeries(candles: Candle[], values: (number|null)[]): { time; value }[] // skips nulls, aligned by index
```
Tests: alignment (nulls dropped, times match), volume colors by close-vs-open.

### T3: `market-data` `type=news&symbol=X` (TDD)
US symbols → Finnhub company-news (24h, cap 10). LSE/crypto → Google News RSS `search?q=<name-or-symbol>` via `parseFeed`. Returns `{ items: {title, url, publishedSec}[] }`, cached 240 s. Test routing/shape with mocked deps.

### T4: Chart UI + navigation
- Add dep `lightweight-charts@^4.2.0`.
- `src/components/PriceChart.tsx`: candles + volume + 20/50/200 MA overlays via one `createChart`; `src/components/RsiChart.tsx`: RSI line + 30/70 guide lines; both auto-resize (ResizeObserver), dark theme options matching CSS vars, cleanup on unmount.
- `src/screens/TickerDetail.tsx`: back button, price header, range pills (3mo/6mo/1y), charts, badges, AlertEditor (moved here), PositionCalculator (entry prefilled = live price, stop prefilled = base low if Basing/Reclaim setup else 5% below), news list.
- Navigation: `App.tsx` state `{screen:'watchlist'} | {screen:'detail', symbol}`; card tap navigates (alert editor no longer inline on watchlist); Charts tab enabled → opens detail for first/last-viewed symbol.
- jsdom cannot run lightweight-charts — charts verified in-browser (T5); calculator + detail data logic covered by T1/T2 tests + an AlertEditor test already existing.

### T5: Browser verification
`netlify dev` + Playwright: seed token, open AAPL detail, screenshot; check candles, MAs, RSI render; calculator math sanity on-screen; fix what the screenshot reveals (fonts, spacing, mobile width 390px).

### T6: Batch deploy
Full test suite + build → merge to main → push → single `netlify deploy --build --prod` → live smoke (detail screen + news endpoint on prod).
