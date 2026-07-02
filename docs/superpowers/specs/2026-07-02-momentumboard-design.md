# MomentumBoard — Design

**Date:** 2026-07-02
**Status:** Draft — awaiting user approval

## 1. Purpose

A mobile-first PWA for a UK swing trader (Trading 212 Stocks & Shares ISA, £5,000 capital) that:

- tracks a watchlist of US stocks and LSE-listed instruments (including leveraged ETPs) with quotes, relative volume, and momentum badges;
- fires alerts (price levels, relative volume >2x, RSI 70/30 crossings, ticker-in-headline news, new videos from followed YouTube channels) via Telegram and in-app toasts;
- shows candlestick charts with 20/50/200 MAs and RSI;
- keeps a trade journal that enforces visibility of the user's hard risk rules;
- shows a daily digest (watchlist performance, earnings calendar, news, YouTube feed, congressional-trading link-out);
- (stage 6) generates an AI-written interpretation of the day's watchlist data and news using the user's Google Gemini or Groq free-tier API key — always labelled as interpretation, never prediction.

**Non-goals:** no order execution, no Trading 212 API integration, no promises of returns anywhere in UI copy, no multi-user auth, no Web Push in v1 (Telegram only), no Supabase in v1.

## 2. Decisions agreed with the user (2026-07-02)

| Decision | Choice |
|---|---|
| Market coverage | US + LSE (hybrid: Finnhub free tier for US quotes/news/calendar; Yahoo Finance unofficial API via our own proxy for LSE quotes and for **all** historical candles, since Finnhub moved candles to its paid tier) |
| Alert config storage | Netlify Blobs (watchlist + alert rules mirrored there so the scheduled function can read them; everything else stays local in IndexedDB) |
| Notifications | Telegram bot only in v1; in-app toasts while the tab is open; Web Push deferred |
| Deployment | GitHub repo → Netlify auto-deploy |
| Data path | All market data flows through Netlify Functions (Approach 1). Chosen on recommendation while the user was away — **revisit if the user objects.** |
| YouTube feeds | Follow Stocks with Josh + a default list of larger stock channels via YouTube RSS (free, no API key); channel list editable in Settings |
| Morning strategy report | Handled OUTSIDE the app: a scheduled claude.ai cloud routine (`trig_01UoyM7HFN1GNRon7auTZJmY`, cron `30 5 * * 1-5` UTC) runs the Daily Sweep research and writes the report each weekday morning. The app's digest complements it; it does not duplicate it. |
| AI interpretation (stage 6) | User supplies a Google Gemini or Groq free-tier API key (server-side env var); an `ai-insights` function summarises/interprets watchlist data + news for the Digest screen. Deferred until core stages 1–5 work. |
| Congressional trading | Digest links out to quiverquant.com/congresstrading (QuiverQuant has no free API; scraping it is brittle — revisit only if the user wants it in-app). The morning routine covers it in research. |
| Portfolio feedback loop | The journal mirrors a portfolio snapshot (open positions with £ sizes, recent outcomes, which report suggestions were followed) to Netlify Blobs; `GET /api/portfolio` exposes it read-only via a separate `REPORT_TOKEN`. After stage 4 ships, the morning routine's prompt is updated to fetch this first so each day's strategy is grounded in what the user actually holds. |

## 3. Stack

- **Client:** React 18 + Vite + TypeScript, single-page PWA (`vite-plugin-pwa` for manifest + service worker, installable to iPhone home screen). Dark theme by default.
- **Local state:** IndexedDB via Dexie (tables: `watchlist`, `alertRules`, `journal`, `settings`, `cache`).
- **Charts:** `lightweight-charts`.
- **Server:** Netlify Functions (TypeScript) + Netlify Blobs + one Netlify Scheduled Function.
- **Testing:** Vitest for all pure modules; mocked-fetch tests for function handlers.
- **Costs:** £0. Free tiers only (Netlify, Finnhub free key, Telegram bot, YouTube/Google News RSS).

TypeScript is an assumption (the brief says "match my existing pattern" but no existing code was available to inspect) — flag to user.

## 4. Architecture

```
┌─────────────── Browser (PWA) ───────────────┐
│ React UI ── Dexie (IndexedDB) ── rules.ts   │
│      │  (same shared modules)      ▲        │
└──────┼─────────────────────────────┼────────┘
       ▼  /api/* (x-app-token)       │ toasts
┌──────────── Netlify Functions ──────────────┐
│ market-data   config-sync    alert-check    │
│     │              │         (cron 15 min)  │
│     ▼              ▼              │         │
│ Finnhub/Yahoo   Netlify Blobs ◄───┤         │
│ /RSS feeds      (config+state)    ▼         │
│                              Telegram API   │
└─────────────────────────────────────────────┘
```

### 4.1 Functions

**`market-data`** — `GET /api/market?type=...`. The only place third-party APIs are called. Keeps the Finnhub key server-side and smooths over Yahoo CORS/user-agent quirks.

- `type=quote&symbols=AAPL,3LTS.L` — batched. US symbols → Finnhub `/quote`; `.L` symbols → Yahoo v8 chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/{sym}`), whose `meta` block carries current price, previous close, and currency without needing Yahoo's crumb/cookie auth.
- `type=candles&symbol=X&range=1y&interval=1d` — Yahoo v8 chart for **all** tickers (basis for MAs, RSI, 30-day average volume).
- `type=news&symbols=...` — Finnhub company-news (US) + Google News RSS queries + stockmarketloop.com/feed/ (user-requested, verified working RSS); parsed server-side to a common shape.
- `type=calendar` — Finnhub earnings calendar (free). Finnhub's *economic* calendar is paid, so the digest shows earnings only plus a static link to an external economic calendar — no paid fallback.
- `type=youtube` — fetches `youtube.com/feeds/videos.xml?channel_id=...` for each followed channel, returns recent videos (title, link, published). Channel IDs are resolved once at config time from channel URLs/handles.
- Responses micro-cached in Blobs (60 s quotes, 15 min candles/news/RSS) so repeated opens and the alert checker don't hammer rate limits.

**`config-sync`** — `GET/PUT /api/config`. Reads/writes one Blobs JSON document: watchlist, alert rules, followed YouTube channels, capital setting. The client mirrors changes here (debounced) whenever the user edits.

**`portfolio`** — `PUT /api/portfolio` (app token) mirrors a journal-derived snapshot to Blobs whenever the journal changes: open positions (ticker, instrument type/leverage, entry, £ size, stop), exposure totals vs guardrails, recent closed-trade outcomes, and suggestion follow-ups. `GET /api/portfolio` serves it read-only, authenticated by a separate `REPORT_TOKEN` env var so the morning research routine can fetch it without holding the app's write token. This is what makes each morning's strategy report portfolio-aware.

**`alert-check`** — scheduled `*/5 * * * *`, 24/7 (~8,600 invocations/month, well inside the 125k free tier) per the user's "never quiet" choice. Inside each run: quote/setup rules evaluate only while the relevant market (LSE or US, incl. US extended hours) is open — prices can't trigger when both are shut; news/YouTube rules evaluate every run. Five-minute cadence is the user's "alerts must be timely" requirement; each run stays lean (one batched quote call; candles/news/RSS refreshed only when their cache TTL lapses) to fit the 10 s function timeout.

**Two-tier routing (user choice):** INSTANT Telegram ping — user-set price levels, setup-state triggers (Reclaim fires, Breakout live, Falling knife → Basing), regime flips, and headlines/videos naming a watchlist ticker. BATCHED — everything else accumulates in Blobs and is sent as a Telegram digest message three times daily (07:00, 14:30, 21:00 UK). No quiet hours: instant-tier pings deliver 24/7. Each run: read config + last-alert state from Blobs → fetch quotes/candles/news/YouTube via the same internal modules → evaluate rules → send Telegram messages for newly triggered alerts → write updated state back. Each ticker/rule is wrapped in try/catch so one bad symbol cannot kill the run.

**Auth:** every `/api/*` call requires an `x-app-token` header matching an `APP_TOKEN` env var (random secret). Single-user pragmatism: the client asks for the token once and keeps it in localStorage. This also stops strangers from burning the Finnhub quota through the public function URL.

### 4.2 Shared modules (`shared/`, imported by both client and functions)

- `indicators.ts` — SMA(20/50/200), RSI(14), ATR(14). Pure, unit-tested against known-good values.
- `setups.ts` — setup detection from daily candles + quote (see §5 Strategy layer): regime state, basing, RSI divergence, reclaim trigger, pullback zone, breakout watch/live, PEAD, overextension, falling-knife warning. Pure functions, unit-tested with fixture candle series.
- `rvol.ts` — relative volume = today's cumulative volume ÷ (30-day average daily volume × elapsed-session fraction). The elapsed-fraction adjustment is an approximation (volume is not uniform intraday — U-shaped in reality); documented as such in code and UI tooltip.
- `rules.ts` — pure function `(config, marketData, lastState) → { alerts, newState }`. Rule types: price crosses level (above/below), RVOL > 2x, RSI crosses 70/30, watchlist ticker appears in a new headline, new video from a followed channel, and **setup transitions** from `setups.ts` (e.g., ticker enters Reclaim or Pullback zone, Breakout goes live, regime banner changes colour). **Dedup/re-arm:** an alert fires once, then re-arms only when the condition resets (price crosses back, RSI leaves the zone) or after 24 h; news/video alerts dedupe on item URL.
- `types.ts` — shared TypeScript types for config, quotes, candles, alerts.

The client runs the exact same `rules.ts` on its polling cycle while the tab is open (instant toasts); the scheduled function covers the rest of the time. One implementation, two hosts — no drift.

### 4.3 Client screens (bottom tab nav, mobile-first)

1. **Watchlist (home)** — top of screen: **regime banner** (green/amber/red from §5, computed from SPY + QQQ daily structure). Per ticker: last price + day change (native currency — USD for US, GBp/GBP for LSE per Yahoo's `meta.currency`, labelled), RVOL, and **setup badges** from `setups.ts` (Basing / Divergence / Reclaim / Pullback zone / Breakout watch / Breakout live / PEAD / Overextended / Falling knife). Pull-to-refresh; "last updated" timestamp; stale-data badge when a fetch fails. While the app is open: quotes poll every 2 min (one batched call; Finnhub's 60/min limit supports ≤30 tickers comfortably), news/RSS every 3 min. Watchlist capped at 30 tickers to respect rate limits.
2. **Ticker detail** — lightweight-charts candlesticks + volume, 20/50/200 MA overlays, RSI(14) sub-panel; ranges 3M/6M/1Y (daily candles); recent news for that ticker; alert-rule editor (add/edit price level, RVOL, RSI, news rules).
3. **Journal** — trade entry form: ticker, direction, instrument type (stock / ETP with leverage factor), entry price, position size (£), invalidation/stop, thesis, dates, exit price, outcome notes. Derived stats: running P&L, win rate, average win/loss. **Risk banners** (thresholds derived from the capital setting, default £5,000): position > 20% of capital; open leveraged-ETP exposure > 30% of capital; estimated risk to stop (leverage-adjusted for ETPs) > 2% of capital. Warnings appear on the entry form *before* saving and as a persistent banner while breached. ETP-tagged entries show two static reminders: "verify ISA eligibility for this product on Trading 212" and a daily-reset decay warning once held > 5 trading days. Each entry can be tagged "followed a report suggestion" (ticker + date), so the app tracks which morning-report ideas were actually taken and how they worked out. Journal detail stays local (IndexedDB, JSON export/import); the summarised portfolio snapshot above is the only journal data that leaves the device.
4. **Digest** — yesterday's watchlist performance (from cached candles), today/this-week's earnings for watchlist tickers (Finnhub calendar), latest headlines, latest videos from followed channels, links to an external economic calendar and QuiverQuant congressional trading. Stage 6 adds an "AI read" card: the `ai-insights` function sends the digest's underlying data (quotes, indicator states, headlines) to Gemini/Groq and renders a short written interpretation — copy labels it "AI interpretation, not a prediction or advice".
5. **Settings** — capital amount, app token, Telegram status (read-only check), followed YouTube channels (resolved to channel IDs on save), alert quiet hours, export/import. Default channel list — user-requested Stocks with Josh, plus well-known stocks channels: Meet Kevin, Financial Education, Everything Money, Tom Nash, Humbled Trader. All removable/replaceable in Settings; treat crowded coverage as sentiment data, not buy signals (per the master prompt's contrarian-warning stance).

### 4.4 Error handling

- Function responses use a `{ ok, data?, error? }` envelope; client surfaces failures as a stale-data badge + last-updated time, never a blank screen (render from Dexie cache first, refresh in background).
- `alert-check` records each run's outcome (timestamp, alerts sent, per-ticker errors, Telegram delivery result) in a Blobs `runlog`; the Settings screen shows the last run status so silent failures are visible.
- Yahoo is unofficial: all Yahoo parsing lives in one adapter module with defensive parsing; if Yahoo breaks, LSE tickers degrade to "unavailable" badges while US tickers (Finnhub) keep working.

### 4.5 Testing

- Vitest unit tests: `indicators` (RSI/SMA vs published reference values), `rules` (each rule type: trigger, no-trigger, re-arm, dedup), `risk` (banner thresholds incl. leverage adjustment), `rvol`.
- Function handlers tested with mocked `fetch` (Finnhub/Yahoo/RSS fixtures checked into the repo).
- Manual smoke test per stage, per the brief's "confirm each stage works before moving on".

## 5. Strategy layer

Settled interactively with the user on 2026-07-02. Honest framing first, and kept in UI copy: **nothing here predicts.** The edge this account can actually have is selectivity, asymmetric risk/reward, regime awareness, and journal-measured expectancy. The aspirational £100/day ≈ 500%/yr on £5,000 and is not a planning assumption.

**Regime filter** (from SPY + QQQ daily candles): **green** = price above rising 20-day and 20 > 50 on both; **red** = either below its 50-day with the 20-day flat/declining; **amber** = anything between. Green: normal operations. Amber: half risk, A-grade setups only. Red: no new longs; short-side playbook eligible. Displayed as a banner; colour changes are alertable.

**Playbooks** (every journal trade is tagged with one):

- **R — Structured reversal** *(primary; the user's preferred style; confirmation required — user chose "wait for the turn")*. Prerequisites: decline ≥25% from 52-wk high or trading below the 200-day; a base of ≥10 sessions with no new 20-day low and contracting range; bonus signal: RSI(14) higher low against a price equal/lower low. Trigger: first daily close back above the 20-day MA or above the base high, with RVOL ≥1.5. Stop below the base low; first target the declining 50-day, then 2R; time stop after 7 sessions without follow-through. Never average down. A **Falling knife** state (fresh 20-day low + RSI <30 + heavy down volume) explicitly suppresses any entry suggestion until a base forms.
- **B — Pullback-in-uptrend.** Price > 50-day > 200-day (or 20 > 50 rising); pullback 3–8% into the 20/50-day zone on fading volume with RSI 35–55. Trigger: a reversal day (higher low, close above the prior day's high). Stop below the swing low; target the prior high, then 2R.
- **A — Breakout continuation** *(green regime only; secondary — user prefers not to chase highs)*. ≥3-week consolidation within 5% of the 52-wk high; trigger: new high on RVOL ≥2. Stop below the breakout level.
- **S — Overextension fade** *(short side via LSE inverse ETPs; user opted in for index AND single-stock)*. Trigger: >2 ATR above the 20-day with RSI >75, or the regime banner flipping red (index case). Max hold 5 sessions (daily-reset decay); single-stock fades run at half risk.
- **Catalyst overlay (PEAD):** an earnings gap >+5% on a beat that holds above its open upgrades any long playbook's conviction. Earnings due within 5 sessions blocks new entries by default (binary-event warning).

**Sizing & exposure** (defaults; user-configurable; warn, never block): capital £5,000; risk per trade 2% (£100) to a structural stop; 2–3 open positions max; 20% (£1,000) max per position; 30% max leveraged-ETP exposure; **small-cap/story-stock class** (market cap <$2bn via Finnhub profile, or user-tagged) risks at half (1%) with spread/gap warnings; leverage only on A-grade conviction with ≤5-session intent.

**App encoding:** `setups.ts` computes per-ticker states (Basing, Divergence, Reclaim, Pullback zone, Breakout watch/live, PEAD, Overextended, Falling knife) plus the regime state; the watchlist shows them as badges; alerts fire on state *transitions*; ticker detail includes a position-size calculator (entry + stop → shares/£, checked against every cap above); the journal's stats screen reports expectancy per playbook so that after ~20 trades the data — not opinion — says which playbooks to keep, shrink, or kill.

## 6. Build stages

Order changed 2026-07-02 (user choice): alerts moved ahead of charts because timeliness is the priority; charts can be done on TradingView/T212 in the interim.

1. **Scaffold + watchlist + quotes** — repo, Vite PWA scaffold, Dexie, `market-data` function (quotes + candles), `indicators.ts` + `setups.ts` with tests (needed for badges), watchlist screen with regime banner + setup badges, GitHub → Netlify pipeline live. *User setup: Finnhub key (provided 2026-07-02), Netlify env vars.*
2. **Alerts + Telegram** — `rules.ts` + tests, two-tier routing, `config-sync` + Blobs mirror, in-app engine, `alert-check` scheduled function (24/7, 5-min), Telegram delivery. *User setup: create bot via BotFather (walkthrough), get chat ID, set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env vars.*
3. **Charts** — ticker detail screen, lightweight-charts (candles + volume + 20/50/200 MAs + RSI panel), position-size calculator.
4. **Journal + risk banners** — journal screens, risk module + tests, export/import, suggestion-followed tagging, portfolio snapshot mirror + `GET /api/portfolio`. *After this stage: update the morning routine's prompt to fetch the portfolio endpoint so reports are based on actual holdings.*
5. **Digest + YouTube** — digest screen, calendar + news + YouTube RSS integration, followed-channels settings.
6. **AI interpretation** — `ai-insights` function (Gemini or Groq, whichever key the user provides), "AI read" card on the Digest, honest labelling. Only starts once 1–5 are confirmed working.

## 6. Risks / caveats

- **Yahoo endpoint is unofficial** and may change or add auth without notice; isolated in one adapter, LSE coverage degrades gracefully. If it dies permanently, the paid-free alternative is Twelve Data's free tier (revisit then).
- **Alert latency, honestly stated:** background checks run every 5 min, so end-to-end alert delay ≈ source lag + ≤5 min. Note the source lag is irreducible on free tiers: YouTube RSS and Google News RSS can trail publication by several minutes. Fast enough for swing entries; this is not, and cannot be, a scalping tool — UI copy says so.
- **RVOL intraday approximation** documented above.
- **Netlify free tier** limits (125k function invocations/month) are comfortably above expected usage (~10–15k/month); the runlog makes usage visible.
- **This app informs, it does not predict.** UI copy must never imply predictive power or promised returns.
