# MomentumBoard Stage 1 — Watchlist Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed PWA showing a watchlist with live quotes (US + LSE), relative volume, a market regime banner, and setup badges (Basing/Reclaim/Pullback/Breakout/Overextended/Falling knife) — the data layer and strategy engine every later stage builds on.

**Architecture:** React+Vite+TS single-page PWA; all market data flows through one Netlify Function (`market-data`) that proxies Finnhub (US quotes) and Yahoo v8 chart (LSE quotes + all candles) with Blobs caching and an `x-app-token` gate. Strategy math lives in pure `shared/` modules imported by both client and functions.

**Tech Stack:** React 18, Vite 5, TypeScript, Dexie (IndexedDB), vite-plugin-pwa, Vitest + Testing Library, Netlify Functions + Blobs.

**Spec:** `docs/superpowers/specs/2026-07-02-momentumboard-design.md` (approved 2026-07-02). Stages 2–6 get their own plans after this stage is confirmed working.

## Global Constraints

- No paid services; Finnhub free tier (60 calls/min) and Yahoo v8 chart endpoint only.
- Finnhub API key and APP_TOKEN live ONLY in Netlify env vars / local `.env` — never in client code, never committed.
- All function responses use envelope `{ ok: boolean, data?: T, error?: string }`.
- Currency displayed in native units, labelled (`USD`, `GBP`, `GBp` — Yahoo reports LSE in either GBp pence or USD; trust `meta.currency`).
- UI copy must never imply prediction or promised returns; latency honesty ("data delayed up to ~2 min") in the footer.
- Watchlist hard cap: 30 tickers. Quote poll: 120 s. Candle refresh: 15 min TTL.
- Setup thresholds (from spec §5, exported as named constants): base ≥10 sessions no new 20-day low; decline prereq ≥25% off 52-wk high or below 200-SMA; reclaim RVOL ≥1.5; breakout RVOL ≥2; pullback 3–8% deep, RSI 35–55; overextended = close > SMA20 + 2×ATR14 AND RSI >75; falling knife = fresh 20-day low + RSI <30 + volume >1.5× 20-day average.
- Node ≥20. Plain JS test assertions via Vitest; no snapshot tests.

## File Structure

```
netlify.toml, package.json, vite.config.ts, tsconfig.json, index.html, .env.example
shared/types.ts            — Candle, Quote, RegimeColor, SetupKind, ApiEnvelope
shared/indicators.ts       — sma, rsi (Wilder), atr (+ tests alongside: *.test.ts)
shared/rvol.ts             — avgDailyVolume, sessionElapsedFraction, relativeVolume
shared/setups.ts           — THRESHOLDS, regimeFromCandles, hasBullishDivergence, detectSetups
netlify/functions/lib/yahoo.ts    — fetchYahooChart(symbol, range) → {candles, quote}
netlify/functions/lib/finnhub.ts  — fetchFinnhubQuote(symbol, apiKey) → Quote
netlify/functions/lib/cache.ts    — getCached/setCached (Blobs, in-memory fallback)
netlify/functions/market-data.mts — handler: auth, routing, caching
src/lib/api.ts             — client fetch wrapper (token header, envelope unwrap)
src/lib/db.ts              — Dexie schema (watchlist, settings)
src/lib/format.ts          — money/pct formatting incl. GBp
src/hooks/useMarketData.ts — polling loop; computes setups + regime from candles
src/components/{RegimeBanner,Badge,TickerRow,AddTickerForm}.tsx
src/screens/Watchlist.tsx
src/{main.tsx,App.tsx,index.css}
public/icon.svg
```

---

### Task 1: Project scaffold

**Files:** Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `netlify.toml`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `.env.example`, `public/icon.svg`; Modify: `.gitignore`

**Interfaces:** Produces the build/test commands every later task runs: `npm run dev`, `npm test`, `npm run build`.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "momentumboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "dexie": "^4.0.8",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@netlify/blobs": "^8.1.0",
    "@netlify/functions": "^2.8.2",
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^24.1.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vite-plugin-pwa": "^0.20.1",
    "vitest": "^2.0.5"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "shared", "netlify"]
}
```

`vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'MomentumBoard',
        short_name: 'MBoard',
        description: 'Watchlist, setups and alerts for swing trading. Informs; does not predict.',
        theme_color: '#0b0e14',
        background_color: '#0b0e14',
        display: 'standalone',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
      }
    })
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts']
  }
})
```

`netlify.toml`:
```toml
[build]
  command = "npm run build"
  publish = "dist"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[redirects]]
  from = "/api/market"
  to = "/.netlify/functions/market-data"
  status = 200
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b0e14" />
    <title>MomentumBoard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/App.tsx` (placeholder until Task 8):
```tsx
export default function App() {
  return <main style={{ padding: 16 }}>MomentumBoard</main>
}
```

`src/index.css`:
```css
:root {
  color-scheme: dark;
  --bg: #0b0e14; --panel: #141a24; --text: #e6e9ef; --muted: #8b93a5;
  --green: #2ecc71; --amber: #f1c40f; --red: #e74c3c; --accent: #4da3ff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, system-ui, sans-serif; }
button, input { font: inherit; }
```

`src/test-setup.ts`:
```ts
import '@testing-library/jest-dom'
```

`public/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0b0e14"/><polyline points="15,70 40,45 55,58 85,25" fill="none" stroke="#4da3ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

`.env.example`:
```
FINNHUB_API_KEY=your-finnhub-key
APP_TOKEN=long-random-secret
```

Append to `.gitignore`:
```
node_modules/
dist/
.env
.netlify/
dev.log
```

- [ ] **Step 2: Install and verify**

Run: `npm install && npm test && npm run build`
Expected: install succeeds; vitest reports "no tests" and exits 0; build outputs `dist/`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: scaffold Vite React TS PWA with Netlify config"
```

---

### Task 2: Shared types + indicators (SMA, RSI, ATR)

**Files:** Create: `shared/types.ts`, `shared/indicators.ts`, `shared/indicators.test.ts`

**Interfaces — Produces:**
```ts
// types.ts
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number } // t = unix sec, daily
export interface Quote { symbol: string; price: number; prevClose: number; changePct: number; currency: string; todayVolume: number | null; asOf: number; source: 'finnhub' | 'yahoo' }
export type RegimeColor = 'green' | 'amber' | 'red'
export type SetupKind = 'basing' | 'divergence' | 'reclaim' | 'pullbackZone' | 'breakoutWatch' | 'breakoutLive' | 'overextended' | 'fallingKnife'
export interface ApiEnvelope<T> { ok: boolean; data?: T; error?: string }
// indicators.ts — arrays index-aligned with input; null until enough data
export function sma(values: number[], period: number): (number | null)[]
export function rsi(closes: number[], period?: number): (number | null)[] // Wilder; both-zero → 50, no losses → 100
export function atr(candles: Candle[], period?: number): (number | null)[]
```

- [ ] **Step 1: Write failing tests** (`shared/indicators.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { sma, rsi, atr } from './indicators'
import type { Candle } from './types'

const bar = (h: number, l: number, c: number): Candle => ({ t: 0, o: c, h, l, c, v: 1000 })

describe('sma', () => {
  it('aligns to input with nulls until period reached', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
})

describe('rsi (Wilder, period 14)', () => {
  it('is 100 for a strictly rising series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    const out = rsi(closes)
    expect(out[13]).toBeNull()
    expect(out[14]).toBe(100)
    expect(out[19]).toBe(100)
  })
  it('is 0 for a strictly falling series', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i)
    expect(rsi(closes)[16]).toBe(0)
  })
  it('is 50 for a symmetric alternating series', () => {
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 10 : 11))
    expect(rsi(closes)[14]).toBeCloseTo(50, 5)
    expect(rsi(closes)[20]).toBeCloseTo(50, 5)
  })
  it('is 50 for a flat series (0/0 convention)', () => {
    expect(rsi(Array(20).fill(7))[15]).toBe(50)
  })
})

describe('atr (period 2)', () => {
  it('computes Wilder ATR from true ranges', () => {
    const candles = [bar(10, 8, 9), bar(11, 9, 10), bar(12, 10, 11)]
    const out = atr(candles, 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBe(2) // mean of TR [2, 2]
    expect(out[2]).toBe(2) // (2*(2-1) + 2)/2
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL: cannot resolve `./indicators`.

- [ ] **Step 3: Implement** (`shared/types.ts` exactly as the Interfaces block above, plus:)

`shared/indicators.ts`:
```ts
import type { Candle } from './types'

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null)
  if (closes.length <= period) return out
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d
    else avgLoss -= d
  }
  avgGain /= period
  avgLoss /= period
  const toRsi = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l))
  out[period] = toRsi(avgGain, avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = toRsi(avgGain, avgLoss)
  }
  return out
}

export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = candles.map(() => null)
  if (candles.length < period + 1) return out
  const tr = (i: number) => {
    const c = candles[i]
    if (i === 0) return c.h - c.l
    const pc = candles[i - 1].c
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc))
  }
  let a = 0
  for (let i = 0; i < period; i++) a += tr(i)
  a /= period
  out[period - 1] = a
  for (let i = period; i < candles.length; i++) {
    a = (a * (period - 1) + tr(i)) / period
    out[i] = a
  }
  return out
}
```

- [ ] **Step 4: Run tests** — `npm test` → all pass.
- [ ] **Step 5: Commit** — `git add shared && git commit -m "feat: shared types and indicators (SMA, Wilder RSI, ATR)"`

---

### Task 3: Relative volume module

**Files:** Create: `shared/rvol.ts`, `shared/rvol.test.ts`

**Interfaces — Produces:**
```ts
export function avgDailyVolume(candles: Candle[], days?: number): number | null // mean volume of last `days` bars EXCLUDING the final bar (today's partial)
export function sessionElapsedFraction(exchange: 'US' | 'LSE', nowUtcSec: number): number // clamped 0.05–1; US 13:30–20:00 UTC, LSE 08:00–16:30 UTC (winter-shifted ±1h acceptable, documented approximation)
export function relativeVolume(todayVolume: number, avgVol: number, elapsedFraction: number): number // todayVolume / (avgVol * elapsedFraction)
```

- [ ] **Step 1: Failing tests** (`shared/rvol.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { avgDailyVolume, sessionElapsedFraction, relativeVolume } from './rvol'
import type { Candle } from './types'

const withVol = (v: number): Candle => ({ t: 0, o: 1, h: 1, l: 1, c: 1, v })

describe('avgDailyVolume', () => {
  it('averages the prior bars, excluding the last (partial today)', () => {
    const candles = [...Array(30).fill(0).map(() => withVol(1000)), withVol(50)]
    expect(avgDailyVolume(candles, 30)).toBe(1000)
  })
  it('returns null with fewer than 5 completed bars', () => {
    expect(avgDailyVolume([withVol(1), withVol(1)], 30)).toBeNull()
  })
})

describe('sessionElapsedFraction', () => {
  // 2026-07-02 is a Thursday. 17:00 UTC is midway-ish through the US session (13:30–20:00 UTC).
  const utc = (h: number, m = 0) => Date.UTC(2026, 6, 2, h, m) / 1000
  it('is ~0.54 midway through the US session', () => {
    expect(sessionElapsedFraction('US', utc(17, 0))).toBeCloseTo((17 - 13.5) / 6.5, 2)
  })
  it('clamps to 1 after the close and 0.05 before the open', () => {
    expect(sessionElapsedFraction('US', utc(22, 0))).toBe(1)
    expect(sessionElapsedFraction('US', utc(11, 0))).toBe(0.05)
    expect(sessionElapsedFraction('LSE', utc(12, 15))).toBeCloseTo(4.25 / 8.5, 2)
  })
})

describe('relativeVolume', () => {
  it('time-adjusts: half the average volume at half the session = 1x', () => {
    expect(relativeVolume(500, 1000, 0.5)).toBe(1)
    expect(relativeVolume(2000, 1000, 0.5)).toBe(4)
  })
})
```

- [ ] **Step 2: Run** — `npm test` → FAIL (module missing).
- [ ] **Step 3: Implement** (`shared/rvol.ts`)

```ts
import type { Candle } from './types'

export function avgDailyVolume(candles: Candle[], days = 30): number | null {
  const completed = candles.slice(0, -1)
  if (completed.length < 5) return null
  const window = completed.slice(-days)
  return window.reduce((s, c) => s + c.v, 0) / window.length
}

const SESSIONS = { US: { open: 13.5, close: 20 }, LSE: { open: 8, close: 16.5 } } as const

export function sessionElapsedFraction(exchange: 'US' | 'LSE', nowUtcSec: number): number {
  const d = new Date(nowUtcSec * 1000)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  const { open, close } = SESSIONS[exchange]
  const frac = (hours - open) / (close - open)
  return Math.min(1, Math.max(0.05, frac))
}

export function relativeVolume(todayVolume: number, avgVol: number, elapsedFraction: number): number {
  return todayVolume / (avgVol * elapsedFraction)
}
```

- [ ] **Step 4: Run** — `npm test` → pass.
- [ ] **Step 5: Commit** — `git commit -am "feat: relative volume with session-elapsed adjustment"`

---

### Task 4: Setup detection engine

**Files:** Create: `shared/setups.ts`, `shared/setups.test.ts`

**Interfaces — Produces:**
```ts
export const THRESHOLDS: {
  baseSessions: 10; declineOffHighPct: 25; reclaimRvol: 1.5; breakoutRvol: 2;
  pullbackMinPct: 3; pullbackMaxPct: 8; overextRsi: 75; knifeRsi: 30; knifeVolX: 1.5
}
export function regimeFromCandles(spy: Candle[], qqq: Candle[]): RegimeColor
export function hasBullishDivergence(closes: number[], rsiVals: (number | null)[], lookback?: number): boolean
export function detectSetups(candles: Candle[], rvol: number | null): SetupKind[] // candles daily, oldest→newest, last bar = today
```

Detection rules (implement exactly; all derived from spec §5):
- `fallingKnife`: last close is the lowest close of the final 20 bars AND RSI14 < 30 AND last volume > 1.5× mean volume of prior 20 bars.
- `basing`: NOT fallingKnife; lowest close of last 10 bars > lowest close of bars −30..−10 (no new low); (high−low range of last 10 bars) < 0.6 × (range of previous 10); and (close ≤ 0.75 × max close of all candles OR close < SMA200 when available).
- `divergence`: basing conditions' decline prereq + `hasBullishDivergence` over last 40 bars: split window in half; min-close index in each half; second min ≤ 1.005 × first min AND rsi[second] > rsi[first] + 2 (both non-null).
- `reclaim`: yesterday's close ≤ yesterday's SMA20 AND today's close > today's SMA20 AND rvol ≥ 1.5 AND the basing conditions held as of yesterday (run basing test on candles minus last bar).
- `pullbackZone`: SMA50 > SMA200 (or SMA200 null and SMA20 > SMA50) AND drawdown from 20-bar-high close between 3% and 8% AND RSI14 between 35 and 55.
- `breakoutWatch`: close ≥ 0.95 × max close AND (max−min close of last 15 bars)/close < 0.08 — and not breakoutLive.
- `breakoutLive`: today's close is the maximum close of the whole series AND rvol ≥ 2.
- `overextended`: close > SMA20 + 2×ATR14 AND RSI14 > 75.

- [ ] **Step 1: Failing tests** (`shared/setups.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { regimeFromCandles, hasBullishDivergence, detectSetups } from './setups'
import type { Candle } from './types'

// Builder: candles from closes; h/l hug close; volume overridable per-bar.
const mk = (closes: number[], vols?: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i, o: c, h: c * 1.01, l: c * 0.99, c, v: vols?.[i] ?? 1000 }))

const rising = (n: number, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => start + i * step)
const falling = (n: number, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => start - i * step)

describe('regimeFromCandles', () => {
  it('green when both indices rise above their 20/50 SMAs', () => {
    const up = mk(rising(60))
    expect(regimeFromCandles(up, up)).toBe('green')
  })
  it('red when an index trades below its falling 50-SMA', () => {
    const down = mk(falling(60))
    expect(regimeFromCandles(down, down)).toBe('red')
  })
  it('amber when mixed', () => {
    expect(regimeFromCandles(mk(rising(60)), mk(falling(60)))).toBe('amber')
  })
})

describe('hasBullishDivergence', () => {
  it('detects equal/lower price low with higher RSI low', () => {
    const closes = Array(40).fill(50)
    closes[10] = 40; closes[30] = 39.9
    const rsiVals: (number | null)[] = Array(40).fill(50)
    rsiVals[10] = 22; rsiVals[30] = 31
    expect(hasBullishDivergence(closes, rsiVals, 40)).toBe(true)
  })
  it('rejects when RSI also makes a lower low', () => {
    const closes = Array(40).fill(50)
    closes[10] = 40; closes[30] = 39.9
    const rsiVals: (number | null)[] = Array(40).fill(50)
    rsiVals[10] = 30; rsiVals[30] = 24
    expect(hasBullishDivergence(closes, rsiVals, 40)).toBe(false)
  })
})

describe('detectSetups', () => {
  // Decline 100→65 over 20 bars, then 25 flat bars closing 64–66 (base), then trigger bar.
  const declineCloses = falling(20, 100, 1.75) // 100 … 66.75
  const baseCloses = Array.from({ length: 25 }, (_, i) => 64 + (i % 3)) // 64,65,66 repeating — no new lows
  it('flags basing after a long base below a big decline', () => {
    const setups = detectSetups(mk([...declineCloses, ...baseCloses]), 1)
    expect(setups).toContain('basing')
    expect(setups).not.toContain('fallingKnife')
  })
  it('flags reclaim when price crosses over SMA20 on volume from a base', () => {
    const closes = [...declineCloses, ...baseCloses, 68] // pops above the ~65 SMA20
    const vols = closes.map(() => 1000); vols[vols.length - 1] = 2500
    const setups = detectSetups(mk(closes, vols), 1.8)
    expect(setups).toContain('reclaim')
  })
  it('flags fallingKnife on a fresh heavy-volume low with weak RSI', () => {
    const closes = falling(40, 100, 1.5) // relentless decline, RSI ≈ 0
    const vols = closes.map(() => 1000); vols[closes.length - 1] = 2000
    const setups = detectSetups(mk(closes, vols), 2)
    expect(setups).toContain('fallingKnife')
    expect(setups).not.toContain('basing')
  })
  it('flags breakoutLive on a fresh all-series high with rvol ≥ 2', () => {
    const closes = [...rising(50, 100, 0.2), 111.5]
    expect(detectSetups(mk(closes), 2.4)).toContain('breakoutLive')
    expect(detectSetups(mk(closes), 1.1)).not.toContain('breakoutLive')
  })
  it('flags pullbackZone on a modest dip in an uptrend', () => {
    // Long uptrend then a 3-bar dip of ~5% from the high
    const up = rising(60, 100, 1) // ends 159
    const dip = [156, 153.5, 151.5] // ~4.7% off 159
    const setups = detectSetups(mk([...up, ...dip]), 0.8)
    expect(setups).toContain('pullbackZone')
  })
  it('flags overextended when stretched >2 ATR above SMA20 with hot RSI', () => {
    // Steady rise then a vertical melt-up
    const closes = [...rising(40, 100, 0.3), 115, 119, 124, 130, 137]
    const setups = detectSetups(mk(closes), 1)
    expect(setups).toContain('overextended')
  })
})
```

- [ ] **Step 2: Run** — `npm test` → FAIL (module missing).
- [ ] **Step 3: Implement** (`shared/setups.ts`)

```ts
import type { Candle, RegimeColor, SetupKind } from './types'
import { sma, rsi, atr } from './indicators'

export const THRESHOLDS = {
  baseSessions: 10, declineOffHighPct: 25, reclaimRvol: 1.5, breakoutRvol: 2,
  pullbackMinPct: 3, pullbackMaxPct: 8, overextRsi: 75, knifeRsi: 30, knifeVolX: 1.5,
} as const

const last = <T,>(a: T[]): T => a[a.length - 1]

function indexHealthy(candles: Candle[]): 'up' | 'down' | 'mixed' {
  const closes = candles.map(c => c.c)
  const s20 = sma(closes, 20), s50 = sma(closes, 50)
  const c = last(closes), m20 = last(s20), m50 = last(s50)
  const m20prev = s20[s20.length - 6] // 20-SMA five bars ago → slope
  if (m20 == null || m50 == null || m20prev == null) return 'mixed'
  if (c > m20 && m20 > m20prev && c > m50) return 'up'
  if (c < m50 && m20 <= m20prev) return 'down'
  return 'mixed'
}

export function regimeFromCandles(spy: Candle[], qqq: Candle[]): RegimeColor {
  const a = indexHealthy(spy), b = indexHealthy(qqq)
  if (a === 'up' && b === 'up') return 'green'
  if (a === 'down' || b === 'down') return a === b ? 'red' : 'amber'
  return 'amber'
}

export function hasBullishDivergence(closes: number[], rsiVals: (number | null)[], lookback = 40): boolean {
  const n = closes.length
  if (n < lookback) return false
  const from = n - lookback, mid = from + Math.floor(lookback / 2)
  const minIdx = (s: number, e: number) => {
    let idx = s
    for (let i = s; i < e; i++) if (closes[i] < closes[idx]) idx = i
    return idx
  }
  const i1 = minIdx(from, mid), i2 = minIdx(mid, n)
  const r1 = rsiVals[i1], r2 = rsiVals[i2]
  if (r1 == null || r2 == null) return false
  return closes[i2] <= closes[i1] * 1.005 && r2 > r1 + 2
}

function isBasing(candles: Candle[]): boolean {
  const closes = candles.map(c => c.c)
  const n = closes.length
  if (n < 40) return false
  const lastN = (arr: number[], k: number) => arr.slice(-k)
  const min = (a: number[]) => Math.min(...a), max = (a: number[]) => Math.max(...a)
  const recent10 = lastN(closes, THRESHOLDS.baseSessions)
  const prior = closes.slice(-30, -THRESHOLDS.baseSessions)
  const noNewLow = min(recent10) > min(prior)
  const recentRange = max(recent10) - min(recent10)
  const prev10 = closes.slice(-20, -10)
  const contracting = recentRange < 0.6 * (max(prev10) - min(prev10))
  const s200 = last(sma(closes, 200))
  const c = last(closes)
  const declined = c <= (1 - THRESHOLDS.declineOffHighPct / 100) * max(closes) || (s200 != null && c < s200)
  return noNewLow && contracting && declined
}

export function detectSetups(candles: Candle[], rvol: number | null): SetupKind[] {
  const out: SetupKind[] = []
  const closes = candles.map(c => c.c)
  const vols = candles.map(c => c.v)
  const n = closes.length
  if (n < 25) return out
  const c = last(closes)
  const rsiSeries = rsi(closes)
  const r = last(rsiSeries)
  const s20series = sma(closes, 20)
  const m20 = last(s20series)
  const m50 = last(sma(closes, 50))
  const m200 = last(sma(closes, 200))
  const a14 = last(atr(candles))
  const min = (a: number[]) => Math.min(...a), max = (a: number[]) => Math.max(...a)

  const avgVol20 = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
  const knife = c <= min(closes.slice(-20)) && r != null && r < THRESHOLDS.knifeRsi && last(vols) > THRESHOLDS.knifeVolX * avgVol20
  if (knife) out.push('fallingKnife')

  if (!knife && isBasing(candles)) out.push('basing')
  if (!knife && hasBullishDivergence(closes, rsiSeries) && c <= 0.75 * max(closes)) out.push('divergence')

  const m20y = s20series[n - 2]
  if (
    m20 != null && m20y != null && closes[n - 2] <= m20y && c > m20 &&
    rvol != null && rvol >= THRESHOLDS.reclaimRvol && isBasing(candles.slice(0, -1))
  ) out.push('reclaim')

  const uptrend = (m50 != null && m200 != null && m50 > m200) || (m200 == null && m20 != null && m50 != null && m20 > m50)
  if (uptrend && m20 != null && r != null) {
    const high20 = max(closes.slice(-20))
    const ddPct = ((high20 - c) / high20) * 100
    if (ddPct >= THRESHOLDS.pullbackMinPct && ddPct <= THRESHOLDS.pullbackMaxPct && r >= 35 && r <= 55) out.push('pullbackZone')
  }

  const allHigh = max(closes)
  if (c >= allHigh && rvol != null && rvol >= THRESHOLDS.breakoutRvol) out.push('breakoutLive')
  else if (c >= 0.95 * allHigh && (max(closes.slice(-15)) - min(closes.slice(-15))) / c < 0.08) out.push('breakoutWatch')

  if (m20 != null && a14 != null && r != null && c > m20 + 2 * a14 && r > THRESHOLDS.overextRsi) out.push('overextended')

  return out
}
```

- [ ] **Step 4: Run** — `npm test` → all pass. If a fixture narrowly misses a threshold (these are hand-built series), adjust the FIXTURE numbers, never the thresholds; re-run.
- [ ] **Step 5: Commit** — `git commit -am "feat: setup detection engine (regime, basing, reclaim, knife, breakout, pullback, overextension)"`

---

### Task 5: Yahoo + Finnhub adapters

**Files:** Create: `netlify/functions/lib/yahoo.ts`, `netlify/functions/lib/finnhub.ts`, `netlify/functions/lib/adapters.test.ts`

**Interfaces — Produces:**
```ts
// yahoo.ts
export function parseYahooChart(json: unknown, symbol: string): { candles: Candle[]; quote: Quote } // throws Error('yahoo-shape') on unexpected shape
export async function fetchYahooChart(symbol: string, range: '3mo'|'6mo'|'1y', fetchFn?: typeof fetch): Promise<{ candles: Candle[]; quote: Quote }>
// finnhub.ts
export async function fetchFinnhubQuote(symbol: string, apiKey: string, fetchFn?: typeof fetch): Promise<Quote>
```
Yahoo URL: `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval=1d` with header `User-Agent: Mozilla/5.0`. Quote fields from `meta`: `regularMarketPrice`, `chartPreviousClose`, `currency`, `regularMarketVolume`, `regularMarketTime`. Candles from `timestamp[]` + `indicators.quote[0]` (skip bars with null close). Finnhub URL: `https://finnhub.io/api/v1/quote?symbol={symbol}&token={key}` → `{c, pc, t}`; `todayVolume` is null from Finnhub (RVOL for US uses Yahoo candles' last bar volume instead).

- [ ] **Step 1: Failing tests** (`netlify/functions/lib/adapters.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest'
import { parseYahooChart, fetchYahooChart } from './yahoo'
import { fetchFinnhubQuote } from './finnhub'

const yahooFixture = {
  chart: { result: [{
    meta: { currency: 'USD', symbol: '3LTS.L', regularMarketPrice: 2.981, chartPreviousClose: 2.167, regularMarketVolume: 5771, regularMarketTime: 1782920120 },
    timestamp: [1782800000, 1782886400],
    indicators: { quote: [{ open: [2.1, 2.5], high: [2.2, 3.0], low: [2.0, 2.4], close: [2.167, 2.981], volume: [4000, 5771] }] }
  }], error: null }
}

describe('parseYahooChart', () => {
  it('maps meta and bars, computing changePct', () => {
    const { candles, quote } = parseYahooChart(yahooFixture, '3LTS.L')
    expect(candles).toHaveLength(2)
    expect(candles[1]).toEqual({ t: 1782886400, o: 2.5, h: 3.0, l: 2.4, c: 2.981, v: 5771 })
    expect(quote.price).toBe(2.981)
    expect(quote.currency).toBe('USD')
    expect(quote.changePct).toBeCloseTo(((2.981 - 2.167) / 2.167) * 100, 4)
    expect(quote.source).toBe('yahoo')
  })
  it('throws yahoo-shape on garbage', () => {
    expect(() => parseYahooChart({ nope: 1 }, 'X')).toThrow('yahoo-shape')
  })
  it('skips bars with null close', () => {
    const fx = structuredClone(yahooFixture)
    fx.chart.result[0].indicators.quote[0].close[0] = null as unknown as number
    expect(parseYahooChart(fx, '3LTS.L').candles).toHaveLength(1)
  })
})

describe('fetchers pass URL and headers', () => {
  it('yahoo: hits v8 chart with UA header', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(yahooFixture)))
    await fetchYahooChart('3LTS.L', '1y', fetchFn as unknown as typeof fetch)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v8/finance/chart/3LTS.L?range=1y&interval=1d')
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('Mozilla')
  })
  it('finnhub: maps c/pc into a Quote', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ c: 294.38, pc: 289.36, t: 1782936000 })))
    const q = await fetchFinnhubQuote('AAPL', 'k', fetchFn as unknown as typeof fetch)
    expect(q.price).toBe(294.38)
    expect(q.changePct).toBeCloseTo(1.7349, 3)
    expect(q.todayVolume).toBeNull()
    expect(q.source).toBe('finnhub')
  })
})
```

- [ ] **Step 2: Run** — FAIL (modules missing).
- [ ] **Step 3: Implement**

`netlify/functions/lib/yahoo.ts`:
```ts
import type { Candle, Quote } from '../../../shared/types'

export function parseYahooChart(json: unknown, symbol: string): { candles: Candle[]; quote: Quote } {
  const r = (json as any)?.chart?.result?.[0]
  const q = r?.indicators?.quote?.[0]
  if (!r?.meta || !Array.isArray(r?.timestamp) || !q) throw new Error('yahoo-shape')
  const candles: Candle[] = []
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i]
    if (c == null) continue
    candles.push({ t: r.timestamp[i], o: q.open[i] ?? c, h: q.high[i] ?? c, l: q.low[i] ?? c, c, v: q.volume[i] ?? 0 })
  }
  const m = r.meta
  const prev = m.chartPreviousClose ?? m.previousClose
  return {
    candles,
    quote: {
      symbol, price: m.regularMarketPrice, prevClose: prev,
      changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : 0,
      currency: m.currency ?? 'USD', todayVolume: m.regularMarketVolume ?? null,
      asOf: m.regularMarketTime ?? Math.floor(Date.now() / 1000), source: 'yahoo',
    },
  }
}

export async function fetchYahooChart(symbol: string, range: '3mo' | '6mo' | '1y', fetchFn: typeof fetch = fetch) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
  if (!res.ok) throw new Error(`yahoo-http-${res.status}`)
  return parseYahooChart(await res.json(), symbol)
}
```

`netlify/functions/lib/finnhub.ts`:
```ts
import type { Quote } from '../../../shared/types'

export async function fetchFinnhubQuote(symbol: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<Quote> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`finnhub-http-${res.status}`)
  const j = (await res.json()) as { c: number; pc: number; t: number }
  if (!j || typeof j.c !== 'number' || j.c === 0) throw new Error('finnhub-shape')
  return {
    symbol, price: j.c, prevClose: j.pc, changePct: j.pc ? ((j.c - j.pc) / j.pc) * 100 : 0,
    currency: 'USD', todayVolume: null, asOf: j.t, source: 'finnhub',
  }
}
```

- [ ] **Step 4: Run** — pass. **Step 5: Commit** — `git commit -am "feat: yahoo and finnhub adapters with fixture tests"`

---

### Task 6: Cache + market-data function

**Files:** Create: `netlify/functions/lib/cache.ts`, `netlify/functions/market-data.mts`, `netlify/functions/lib/market-data.test.ts`

**Interfaces — Produces:**
- `cache.ts`: `getCached<T>(key: string): Promise<T | null>`, `setCached(key: string, value: unknown, ttlSec: number): Promise<void>` — Netlify Blobs store `"cache"` when available, module-level `Map` fallback otherwise (local tests / `vite` context). Entries store `{ value, expires }`; expired reads return null.
- `market-data.mts`: default export Netlify Function. Routes on `?type=`:
  - `quote&symbols=A,B` → `{ ok, data: { quotes: Quote[] } }` — `.L`/`.`-suffixed symbols via `fetchYahooChart(sym,'3mo')`.quote (cache 60 s), others via `fetchFinnhubQuote` (cache 60 s). A failed symbol becomes `null` in place (never fails the batch).
  - `candles&symbol=X&range=1y` → `{ ok, data: { candles, quote } }` (cache 900 s).
  - anything else → 400 `{ ok: false, error: 'bad-type' }`.
  - Auth: every request must carry header `x-app-token` equal to `process.env.APP_TOKEN`, else 401 `{ ok: false, error: 'unauthorized' }`.
- Also exports pure `routeRequest(url: URL, headers: Headers, env: { APP_TOKEN?: string; FINNHUB_API_KEY?: string }, deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote })` so tests avoid the Netlify runtime.

- [ ] **Step 1: Failing tests** (`netlify/functions/lib/market-data.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest'
import { routeRequest } from '../market-data.mjs'
import type { Quote } from '../../../shared/types'

const q = (symbol: string): Quote => ({ symbol, price: 1, prevClose: 1, changePct: 0, currency: 'USD', todayVolume: null, asOf: 0, source: 'finnhub' })
const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }
const deps = {
  yahoo: vi.fn(async (s: string) => ({ candles: [], quote: { ...q(s), source: 'yahoo' as const } })),
  finnhub: vi.fn(async (s: string) => q(s)),
}
const call = (qs: string, token?: string) =>
  routeRequest(new URL(`http://x/api/market?${qs}`), new Headers(token ? { 'x-app-token': token } : {}), env, deps)

describe('market-data routing', () => {
  it('rejects a missing/wrong token', async () => {
    const res = await call('type=quote&symbols=AAPL')
    expect(res.status).toBe(401)
  })
  it('routes US to finnhub and .L to yahoo in one batch', async () => {
    const res = await call('type=quote&symbols=AAPL,3LTS.L', 'secret')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data.quotes.map((x: Quote | null) => x?.source)).toEqual(['finnhub', 'yahoo'])
  })
  it('nulls a failing symbol without failing the batch', async () => {
    deps.finnhub.mockRejectedValueOnce(new Error('boom'))
    const body = await (await call('type=quote&symbols=AAPL,3LTS.L', 'secret')).json()
    expect(body.data.quotes[0]).toBeNull()
    expect(body.data.quotes[1]).not.toBeNull()
  })
  it('400s unknown type', async () => {
    expect((await call('type=wat', 'secret')).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

`netlify/functions/lib/cache.ts`:
```ts
type Entry = { value: unknown; expires: number }
const mem = new Map<string, Entry>()

async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore('cache')
  } catch {
    return null
  }
}

export async function getCached<T>(key: string): Promise<T | null> {
  const store = await blobStore()
  const entry = store ? ((await store.get(key, { type: 'json' })) as Entry | null) : (mem.get(key) ?? null)
  if (!entry || entry.expires < Date.now()) return null
  return entry.value as T
}

export async function setCached(key: string, value: unknown, ttlSec: number): Promise<void> {
  const entry: Entry = { value, expires: Date.now() + ttlSec * 1000 }
  const store = await blobStore()
  if (store) await store.setJSON(key, entry)
  else mem.set(key, entry)
}
```

`netlify/functions/market-data.mts`:
```ts
import type { Context } from '@netlify/functions'
import { fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { getCached, setCached } from './lib/cache'
import type { Quote } from '../../shared/types'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const isYahooSymbol = (s: string) => s.includes('.')

export async function routeRequest(
  url: URL,
  headers: Headers,
  env: { APP_TOKEN?: string; FINNHUB_API_KEY?: string },
  deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote },
): Promise<Response> {
  if (!env.APP_TOKEN || headers.get('x-app-token') !== env.APP_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
  const type = url.searchParams.get('type')

  if (type === 'quote') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    const quotes = await Promise.all(
      symbols.map(async (sym): Promise<Quote | null> => {
        const key = `quote:${sym}`
        const hit = await getCached<Quote>(key)
        if (hit) return hit
        try {
          const quote = isYahooSymbol(sym) ? (await deps.yahoo(sym, '3mo')).quote : await deps.finnhub(sym, env.FINNHUB_API_KEY ?? '')
          await setCached(key, quote, 60)
          return quote
        } catch {
          return null
        }
      }),
    )
    return json(200, { ok: true, data: { quotes } })
  }

  if (type === 'candles') {
    const symbol = url.searchParams.get('symbol')
    const range = (url.searchParams.get('range') ?? '1y') as '3mo' | '6mo' | '1y'
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `candles:${symbol}:${range}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const data = await deps.yahoo(symbol, range)
      await setCached(key, data, 900)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  return json(400, { ok: false, error: 'bad-type' })
}

export default async (req: Request, _context: Context) =>
  routeRequest(new URL(req.url), req.headers, { APP_TOKEN: process.env.APP_TOKEN, FINNHUB_API_KEY: process.env.FINNHUB_API_KEY }, { yahoo: fetchYahooChart, finnhub: fetchFinnhubQuote })
```

- [ ] **Step 4: Run** — `npm test` → pass.
- [ ] **Step 5: Local end-to-end check** — create `.env` from `.env.example` with the real Finnhub key and `APP_TOKEN=$(openssl rand -hex 24)`. Run `npx netlify dev` in background; then:
`curl -s -H "x-app-token: $APP_TOKEN" "http://localhost:8888/api/market?type=quote&symbols=AAPL,3LTS.L"`
Expected: `{"ok":true,"data":{"quotes":[{...price...},{...price...}]}}`
- [ ] **Step 6: Commit** — `git commit -am "feat: market-data function with blobs cache and token auth"`

---

### Task 7: Client data layer (db, api, format)

**Files:** Create: `src/lib/db.ts`, `src/lib/api.ts`, `src/lib/format.ts`, `src/lib/format.test.ts`, `src/lib/api.test.ts`

**Interfaces — Produces:**
```ts
// db.ts
export interface WatchItem { symbol: string; addedAt: number; riskClass: 'normal' | 'speculative' }
export const db: Dexie & { watchlist: Table<WatchItem, string>; settings: Table<{ key: string; value: string }, string> }
// api.ts
export function getToken(): string | null            // localStorage 'mb-token'
export function setToken(t: string): void
export async function apiGet<T>(path: string): Promise<T>  // throws Error(error) on !ok envelope or 401
export const getQuotes: (symbols: string[]) => Promise<(Quote | null)[]>
export const getCandles: (symbol: string, range?: string) => Promise<{ candles: Candle[]; quote: Quote }>
// format.ts
export function fmtPrice(price: number, currency: string): string // GBp → '123.4p', GBP → '£1.23', USD → '$1.23'
export function fmtPct(p: number): string // '+1.73%' / '−0.50%'
```

- [ ] **Step 1: Failing tests**

`src/lib/format.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fmtPrice, fmtPct } from './format'

describe('fmtPrice', () => {
  it('renders pence for GBp', () => expect(fmtPrice(123.4, 'GBp')).toBe('123.4p'))
  it('renders pounds for GBP', () => expect(fmtPrice(1.234, 'GBP')).toBe('£1.23'))
  it('renders dollars for USD', () => expect(fmtPrice(2.981, 'USD')).toBe('$2.98'))
})
describe('fmtPct', () => {
  it('signs both directions', () => {
    expect(fmtPct(1.7349)).toBe('+1.73%')
    expect(fmtPct(-0.5)).toBe('−0.50%')
  })
})
```

`src/lib/api.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiGet, setToken } from './api'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('apiGet', () => {
  it('sends the token header and unwraps the envelope', async () => {
    setToken('tok')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { x: 1 } })))
    await expect(apiGet('/api/market?type=quote&symbols=A')).resolves.toEqual({ x: 1 })
    const [, init] = spy.mock.calls[0]
    expect((init!.headers as Record<string, string>)['x-app-token']).toBe('tok')
  })
  it('throws on error envelope', async () => {
    setToken('tok')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }))
    await expect(apiGet('/x')).rejects.toThrow('unauthorized')
  })
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

`src/lib/format.ts`:
```ts
export function fmtPrice(price: number, currency: string): string {
  if (currency === 'GBp') return `${price.toFixed(1)}p`
  const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `
  return `${sym}${price.toFixed(2)}`
}
export function fmtPct(p: number): string {
  const sign = p >= 0 ? '+' : '−'
  return `${sign}${Math.abs(p).toFixed(2)}%`
}
```

`src/lib/db.ts`:
```ts
import Dexie, { type Table } from 'dexie'

export interface WatchItem { symbol: string; addedAt: number; riskClass: 'normal' | 'speculative' }

class MBDatabase extends Dexie {
  watchlist!: Table<WatchItem, string>
  settings!: Table<{ key: string; value: string }, string>
  constructor() {
    super('momentumboard')
    this.version(1).stores({ watchlist: 'symbol', settings: 'key' })
  }
}
export const db = new MBDatabase()
```

`src/lib/api.ts`:
```ts
import type { ApiEnvelope, Candle, Quote } from '../../shared/types'

export const getToken = () => localStorage.getItem('mb-token')
export const setToken = (t: string) => localStorage.setItem('mb-token', t)

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'x-app-token': getToken() ?? '' } })
  const body = (await res.json()) as ApiEnvelope<T>
  if (!body.ok || body.data === undefined) throw new Error(body.error ?? `http-${res.status}`)
  return body.data
}

export const getQuotes = (symbols: string[]) =>
  apiGet<{ quotes: (Quote | null)[] }>(`/api/market?type=quote&symbols=${symbols.join(',')}`).then(d => d.quotes)
export const getCandles = (symbol: string, range = '1y') =>
  apiGet<{ candles: Candle[]; quote: Quote }>(`/api/market?type=candles&symbol=${encodeURIComponent(symbol)}&range=${range}`)
```

- [ ] **Step 4: Run** — pass. **Step 5: Commit** — `git commit -am "feat: client data layer (dexie, api client, formatting)"`

---

### Task 8: Watchlist UI + polling hook

**Files:** Create: `src/hooks/useMarketData.ts`, `src/components/RegimeBanner.tsx`, `src/components/Badge.tsx`, `src/components/TickerRow.tsx`, `src/components/AddTickerForm.tsx`, `src/screens/Watchlist.tsx`, `src/components/TickerRow.test.tsx`; Modify: `src/App.tsx`

**Interfaces — Consumes:** everything above. **Produces:** `useMarketData(symbols: string[]) → { rows: Row[]; regime: RegimeColor | null; lastUpdated: number | null; error: string | null }` where `Row = { symbol: string; quote: Quote | null; rvol: number | null; setups: SetupKind[] }`.

Behavior: on mount and every 120 s → `getQuotes(symbols)`. Per symbol every 15 min (and on add) → `getCandles(symbol)`, kept in a `Map` in a ref; RVOL from `avgDailyVolume` + `sessionElapsedFraction` (exchange = `.`-suffix ? 'LSE' : 'US') + `todayVolume ?? last candle volume`; setups via `detectSetups(candles, rvol)`. Regime: fetch SPY + QQQ candles on the same 15-min cycle → `regimeFromCandles`. All fetch errors set `error` but keep the last good data (stale badge, not blank screen).

- [ ] **Step 1: Failing component test** (`src/components/TickerRow.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react'
import { TickerRow } from './TickerRow'

it('renders price, change, rvol and badges', () => {
  render(<TickerRow row={{
    symbol: '3LTS.L',
    quote: { symbol: '3LTS.L', price: 2.981, prevClose: 2.167, changePct: 37.56, currency: 'USD', todayVolume: 5771, asOf: 0, source: 'yahoo' },
    rvol: 2.3, setups: ['basing', 'reclaim'],
  }} onRemove={() => {}} />)
  expect(screen.getByText('3LTS.L')).toBeInTheDocument()
  expect(screen.getByText('$2.98')).toBeInTheDocument()
  expect(screen.getByText('+37.56%')).toBeInTheDocument()
  expect(screen.getByText('RVOL 2.3x')).toBeInTheDocument()
  expect(screen.getByText('Basing')).toBeInTheDocument()
  expect(screen.getByText('Reclaim')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

`src/components/Badge.tsx`:
```tsx
import type { SetupKind } from '../../shared/types'

const LABELS: Record<SetupKind, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  basing: { text: 'Basing', tone: 'info' },
  divergence: { text: 'Divergence', tone: 'info' },
  reclaim: { text: 'Reclaim', tone: 'good' },
  pullbackZone: { text: 'Pullback zone', tone: 'good' },
  breakoutWatch: { text: 'Breakout watch', tone: 'info' },
  breakoutLive: { text: 'Breakout live', tone: 'good' },
  overextended: { text: 'Overextended', tone: 'warn' },
  fallingKnife: { text: 'Falling knife', tone: 'bad' },
}
const COLORS = { good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', info: 'var(--accent)' }

export function Badge({ kind }: { kind: SetupKind }) {
  const { text, tone } = LABELS[kind]
  return (
    <span style={{ border: `1px solid ${COLORS[tone]}`, color: COLORS[tone], borderRadius: 999, padding: '1px 8px', fontSize: 12, marginRight: 4 }}>
      {text}
    </span>
  )
}
```

`src/components/RegimeBanner.tsx`:
```tsx
import type { RegimeColor } from '../../shared/types'

const COPY: Record<RegimeColor, string> = {
  green: 'Regime: GREEN — tape supports longs',
  amber: 'Regime: AMBER — half size, A-grade setups only',
  red: 'Regime: RED — defensive; no new longs',
}
export function RegimeBanner({ regime }: { regime: RegimeColor | null }) {
  if (!regime) return null
  return (
    <div style={{ background: `var(--${regime === 'green' ? 'green' : regime === 'amber' ? 'amber' : 'red'})`, color: '#0b0e14', padding: '6px 12px', borderRadius: 8, fontWeight: 600, marginBottom: 12 }}>
      {COPY[regime]}
    </div>
  )
}
```

`src/components/TickerRow.tsx`:
```tsx
import type { Quote, SetupKind } from '../../shared/types'
import { fmtPrice, fmtPct } from '../lib/format'
import { Badge } from './Badge'

export interface Row { symbol: string; quote: Quote | null; rvol: number | null; setups: SetupKind[] }

export function TickerRow({ row, onRemove }: { row: Row; onRemove: () => void }) {
  const { symbol, quote, rvol, setups } = row
  return (
    <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{symbol}</strong>
        <span>
          {quote ? fmtPrice(quote.price, quote.currency) : '—'}{' '}
          {quote && (
            <span style={{ color: quote.changePct >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtPct(quote.changePct)}</span>
          )}
        </span>
      </div>
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {rvol != null && <span style={{ color: 'var(--muted)', fontSize: 12 }}>RVOL {rvol.toFixed(1)}x</span>}
        {setups.map(s => <Badge key={s} kind={s} />)}
        <button onClick={onRemove} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>✕</button>
      </div>
    </div>
  )
}
```

`src/components/AddTickerForm.tsx`:
```tsx
import { useState } from 'react'

export function AddTickerForm({ onAdd, disabled }: { onAdd: (symbol: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={e => { e.preventDefault(); const s = value.trim().toUpperCase(); if (s) { onAdd(s); setValue('') } }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <input value={value} onChange={e => setValue(e.target.value)} placeholder="Add ticker (AAPL or 3LTS.L)" disabled={disabled}
        style={{ flex: 1, background: 'var(--panel)', border: '1px solid #2a3242', borderRadius: 8, padding: '8px 10px', color: 'var(--text)' }} />
      <button disabled={disabled} style={{ background: 'var(--accent)', border: 'none', borderRadius: 8, padding: '8px 14px', color: '#0b0e14', fontWeight: 600 }}>Add</button>
    </form>
  )
}
```

`src/hooks/useMarketData.ts`:
```ts
import { useEffect, useRef, useState } from 'react'
import type { Candle, Quote, RegimeColor, SetupKind } from '../../shared/types'
import { getQuotes, getCandles } from '../lib/api'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction } from '../../shared/rvol'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import type { Row } from '../components/TickerRow'

const QUOTE_MS = 120_000
const CANDLE_MS = 900_000

export function useMarketData(symbols: string[]) {
  const [rows, setRows] = useState<Row[]>([])
  const [regime, setRegime] = useState<RegimeColor | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const candlesRef = useRef(new Map<string, Candle[]>())
  const fetchedAtRef = useRef(new Map<string, number>())

  useEffect(() => {
    let alive = true

    async function refreshCandles() {
      const wanted = [...symbols, 'SPY', 'QQQ']
      for (const sym of wanted) {
        const at = fetchedAtRef.current.get(sym) ?? 0
        if (Date.now() - at < CANDLE_MS) continue
        try {
          const { candles } = await getCandles(sym)
          candlesRef.current.set(sym, candles)
          fetchedAtRef.current.set(sym, Date.now())
        } catch (e) {
          setError(String(e))
        }
      }
      const spy = candlesRef.current.get('SPY')
      const qqq = candlesRef.current.get('QQQ')
      if (spy && qqq && alive) setRegime(regimeFromCandles(spy, qqq))
    }

    async function refreshQuotes() {
      if (symbols.length === 0) { setRows([]); return }
      try {
        const quotes = await getQuotes(symbols)
        if (!alive) return
        const now = Math.floor(Date.now() / 1000)
        setRows(symbols.map((symbol, i) => {
          const quote: Quote | null = quotes[i]
          const candles = candlesRef.current.get(symbol)
          let rvol: number | null = null
          let setups: SetupKind[] = []
          if (candles && candles.length > 25) {
            const avg = avgDailyVolume(candles)
            const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
            if (avg) rvol = relativeVolume(todayVol, avg, sessionElapsedFraction(symbol.includes('.') ? 'LSE' : 'US', now))
            setups = detectSetups(candles, rvol)
          }
          return { symbol, quote, rvol, setups }
        }))
        setLastUpdated(Date.now())
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    }

    refreshCandles().then(refreshQuotes)
    const qi = setInterval(refreshQuotes, QUOTE_MS)
    const ci = setInterval(() => refreshCandles().then(refreshQuotes), CANDLE_MS)
    return () => { alive = false; clearInterval(qi); clearInterval(ci) }
  }, [symbols.join(',')])

  return { rows, regime, lastUpdated, error }
}
```

`src/screens/Watchlist.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getToken, setToken } from '../lib/api'
import { useMarketData } from '../hooks/useMarketData'
import { RegimeBanner } from '../components/RegimeBanner'
import { TickerRow } from '../components/TickerRow'
import { AddTickerForm } from '../components/AddTickerForm'

export function Watchlist() {
  const [symbols, setSymbols] = useState<string[]>([])
  const [hasToken, setHasToken] = useState(!!getToken())
  const { rows, regime, lastUpdated, error } = useMarketData(symbols)

  useEffect(() => { db.watchlist.toArray().then(items => setSymbols(items.map(i => i.symbol))) }, [])

  const add = async (symbol: string) => {
    if (symbols.includes(symbol) || symbols.length >= 30) return
    await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal' })
    setSymbols(s => [...s, symbol])
  }
  const remove = async (symbol: string) => {
    await db.watchlist.delete(symbol)
    setSymbols(s => s.filter(x => x !== symbol))
  }

  if (!hasToken) {
    return (
      <main style={{ padding: 16, maxWidth: 480, margin: '0 auto' }}>
        <h1>MomentumBoard</h1>
        <p style={{ color: 'var(--muted)' }}>Enter your app token (the APP_TOKEN you set in Netlify).</p>
        <form onSubmit={e => { e.preventDefault(); const t = new FormData(e.currentTarget).get('t') as string; if (t) { setToken(t.trim()); setHasToken(true) } }}>
          <input name="t" type="password" placeholder="App token" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #2a3242', background: 'var(--panel)', color: 'var(--text)' }} />
          <button style={{ marginTop: 10, width: '100%', padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', fontWeight: 600 }}>Save</button>
        </form>
      </main>
    )
  }

  return (
    <main style={{ padding: 16, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22 }}>MomentumBoard</h1>
      <RegimeBanner regime={regime} />
      <AddTickerForm onAdd={add} disabled={symbols.length >= 30} />
      {rows.map(row => <TickerRow key={row.symbol} row={row} onRemove={() => remove(row.symbol)} />)}
      {rows.length === 0 && <p style={{ color: 'var(--muted)' }}>Add a ticker to get started. US symbols plain (AAPL); LSE with suffix (3LTS.L).</p>}
      <footer style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>
        {error ? `⚠ data stale: ${error}` : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : 'Loading…'}
        {' · '}Data delayed up to ~2 min. This app informs — it does not predict.
      </footer>
    </main>
  )
}
```

`src/App.tsx` (replace):
```tsx
import { Watchlist } from './screens/Watchlist'
export default function App() { return <Watchlist /> }
```

- [ ] **Step 4: Run tests + build** — `npm test && npm run build` → pass, build clean.
- [ ] **Step 5: Manual smoke via netlify dev** — `npx netlify dev` in background; open http://localhost:8888, enter the APP_TOKEN from `.env`, add `AAPL` and `3LTS.L`; verify prices, change %, RVOL, and (for a beaten-down ETP) badges render; verify the regime banner appears after ~2 s.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: watchlist screen with regime banner, setup badges, polling"`

---

### Task 9: GitHub + Netlify deployment

**Files:** none new (repo/site wiring). **Consumes:** working local app.

- [ ] **Step 1: Check auth** — `gh auth status` and `npx netlify status`. If either is unauthenticated, STOP and ask the user to run `! gh auth login` / `! npx netlify login` in the session.
- [ ] **Step 2: Create private GitHub repo and push** —
```bash
gh repo create momentumboard --private --source . --push
```
Expected: repo created, `main` pushed.
- [ ] **Step 3: Create + link Netlify site** — `npx netlify init` non-interactively is unreliable; prefer: `npx netlify sites:create --name momentumboard-<random4>` then `npx netlify link --id <site-id>`, then connect the GitHub repo for CI builds via `npx netlify init` (choose the existing site). If interactive prompts block automation, fall back to `npx netlify deploy --build --prod` (manual deploys) and note that GitHub auto-deploy can be connected in the Netlify UI later; tell the user either way.
- [ ] **Step 4: Set env vars** —
```bash
npx netlify env:set FINNHUB_API_KEY <key from .env>
npx netlify env:set APP_TOKEN <token from .env>
```
- [ ] **Step 5: Deploy + live smoke test** — trigger a deploy (git push if CI-connected, else `npx netlify deploy --build --prod`). Then:
```bash
curl -s -H "x-app-token: $APP_TOKEN" "https://<site>.netlify.app/api/market?type=quote&symbols=AAPL,3LTS.L"
```
Expected: `ok:true` with two quotes. Then open the site URL, enter token, add tickers, confirm the same behavior as local. Confirm 401 without the token header.
- [ ] **Step 6: Commit any wiring files** (`.netlify/state.json` is gitignored; netlify.toml already committed) and report the live URL to the user for stage-1 sign-off.

---

## Self-Review (done at plan time)

- **Spec coverage (stage 1 scope):** watchlist+quotes ✓ (T5–T8), indicators+setups with tests ✓ (T2–T4), regime banner ✓ (T4, T8), RVOL ✓ (T3), token auth ✓ (T6), caching ✓ (T6), currency handling ✓ (T5, T7), 30-ticker cap ✓ (T6, T8), honesty footer ✓ (T8), deploy pipeline ✓ (T9). Deferred by design: PEAD badge (needs earnings calendar — stage 5), riskClass auto-tagging via market cap (stage 4, journal sizing), PNG/apple-touch icons (stage 5 polish), `config-sync`/Blobs mirror (stage 2, alerts need it).
- **Placeholders:** none — every code step has complete code.
- **Type consistency:** `Quote.source: 'finnhub' | 'yahoo'`, `Row`, `SetupKind`, envelope shape used consistently across T2/T5/T6/T7/T8.
