# MomentumBoard — Design

**Date:** 2026-07-02
**Status:** Draft — awaiting user approval

## 1. Purpose

A mobile-first PWA for a UK swing trader (Trading 212 Stocks & Shares ISA, £5,000 capital) that:

- tracks a watchlist of US stocks and LSE-listed instruments (including leveraged ETPs) with quotes, relative volume, and momentum badges;
- fires alerts (price levels, relative volume >2x, RSI 70/30 crossings, ticker-in-headline news, new videos from followed YouTube channels) via Telegram and in-app toasts;
- shows candlestick charts with 20/50/200 MAs and RSI;
- keeps a trade journal that enforces visibility of the user's hard risk rules;
- shows a daily digest (watchlist performance, earnings calendar, news, YouTube feed).

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
- `type=news&symbols=...` — Finnhub company-news (US) + Google News RSS queries; parsed server-side to a common shape.
- `type=calendar` — Finnhub earnings calendar (free). Finnhub's *economic* calendar is paid, so the digest shows earnings only plus a static link to an external economic calendar — no paid fallback.
- `type=youtube` — fetches `youtube.com/feeds/videos.xml?channel_id=...` for each followed channel, returns recent videos (title, link, published). Channel IDs are resolved once at config time from channel URLs/handles.
- Responses micro-cached in Blobs (60 s quotes, 15 min candles/news/RSS) so repeated opens and the alert checker don't hammer rate limits.

**`config-sync`** — `GET/PUT /api/config`. Reads/writes one Blobs JSON document: watchlist, alert rules, followed YouTube channels, capital setting. The client mirrors changes here (debounced) whenever the user edits.

**`alert-check`** — scheduled `*/15 6-21 * * 1-5` (UTC; covers LSE 08:00 London through US close 21:00/22:00 London, weekdays). Each run: read config + last-alert state from Blobs → fetch quotes/candles/news/YouTube via the same internal modules → evaluate rules → send Telegram messages for newly triggered alerts → write updated state back. Each ticker/rule is wrapped in try/catch so one bad symbol cannot kill the run.

**Auth:** every `/api/*` call requires an `x-app-token` header matching an `APP_TOKEN` env var (random secret). Single-user pragmatism: the client asks for the token once and keeps it in localStorage. This also stops strangers from burning the Finnhub quota through the public function URL.

### 4.2 Shared modules (`shared/`, imported by both client and functions)

- `indicators.ts` — SMA(20/50/200), RSI(14). Pure, unit-tested against known-good values.
- `rvol.ts` — relative volume = today's cumulative volume ÷ (30-day average daily volume × elapsed-session fraction). The elapsed-fraction adjustment is an approximation (volume is not uniform intraday — U-shaped in reality); documented as such in code and UI tooltip.
- `rules.ts` — pure function `(config, marketData, lastState) → { alerts, newState }`. Rule types: price crosses level (above/below), RVOL > 2x, RSI crosses 70/30, watchlist ticker appears in a new headline, new video from a followed channel. **Dedup/re-arm:** an alert fires once, then re-arms only when the condition resets (price crosses back, RSI leaves the zone) or after 24 h; news/video alerts dedupe on item URL.
- `types.ts` — shared TypeScript types for config, quotes, candles, alerts.

The client runs the exact same `rules.ts` on its polling cycle while the tab is open (instant toasts); the scheduled function covers the rest of the time. One implementation, two hosts — no drift.

### 4.3 Client screens (bottom tab nav, mobile-first)

1. **Watchlist (home)** — per ticker: last price + day change (native currency — USD for US, GBp/GBP for LSE per Yahoo's `meta.currency`, labelled), RVOL, momentum badge (▲ above 20-day MA / ▼ below; RSI zone chip: <30 / 30–70 / >70). Pull-to-refresh; "last updated" timestamp; stale-data badge when a fetch fails. 15-min auto-poll while open. Watchlist capped at 30 tickers to respect rate limits.
2. **Ticker detail** — lightweight-charts candlesticks + volume, 20/50/200 MA overlays, RSI(14) sub-panel; ranges 3M/6M/1Y (daily candles); recent news for that ticker; alert-rule editor (add/edit price level, RVOL, RSI, news rules).
3. **Journal** — trade entry form: ticker, direction, instrument type (stock / ETP with leverage factor), entry price, position size (£), invalidation/stop, thesis, dates, exit price, outcome notes. Derived stats: running P&L, win rate, average win/loss. **Risk banners** (thresholds derived from the capital setting, default £5,000): position > 20% of capital; open leveraged-ETP exposure > 30% of capital; estimated risk to stop (leverage-adjusted for ETPs) > 2% of capital. Warnings appear on the entry form *before* saving and as a persistent banner while breached. ETP-tagged entries show two static reminders: "verify ISA eligibility for this product on Trading 212" and a daily-reset decay warning once held > 5 trading days. Journal is local-only (IndexedDB) with JSON export/import for backup.
4. **Digest** — yesterday's watchlist performance (from cached candles), today/this-week's earnings for watchlist tickers (Finnhub calendar), latest headlines, latest videos from followed channels, link to an external economic calendar.
5. **Settings** — capital amount, app token, Telegram status (read-only check), followed YouTube channels (resolved to channel IDs on save), alert quiet hours, export/import. Default channel list — user-requested Stocks with Josh, plus well-known stocks channels: Meet Kevin, Financial Education, Everything Money, Tom Nash, Humbled Trader. All removable/replaceable in Settings; treat crowded coverage as sentiment data, not buy signals (per the master prompt's contrarian-warning stance).

### 4.4 Error handling

- Function responses use a `{ ok, data?, error? }` envelope; client surfaces failures as a stale-data badge + last-updated time, never a blank screen (render from Dexie cache first, refresh in background).
- `alert-check` records each run's outcome (timestamp, alerts sent, per-ticker errors, Telegram delivery result) in a Blobs `runlog`; the Settings screen shows the last run status so silent failures are visible.
- Yahoo is unofficial: all Yahoo parsing lives in one adapter module with defensive parsing; if Yahoo breaks, LSE tickers degrade to "unavailable" badges while US tickers (Finnhub) keep working.

### 4.5 Testing

- Vitest unit tests: `indicators` (RSI/SMA vs published reference values), `rules` (each rule type: trigger, no-trigger, re-arm, dedup), `risk` (banner thresholds incl. leverage adjustment), `rvol`.
- Function handlers tested with mocked `fetch` (Finnhub/Yahoo/RSS fixtures checked into the repo).
- Manual smoke test per stage, per the brief's "confirm each stage works before moving on".

## 5. Build stages

1. **Scaffold + watchlist + quotes** — repo, Vite PWA scaffold, Dexie, `market-data` function (quotes + candles), watchlist screen with badges, GitHub → Netlify pipeline live. *User setup: Finnhub free API key, Netlify env vars.*
2. **Charts** — ticker detail screen, lightweight-charts, indicators module + tests.
3. **Alerts** — `rules.ts` + tests, `config-sync` + Blobs mirror, in-app engine, `alert-check` scheduled function, Telegram delivery. *User setup: create bot via BotFather (walkthrough), get chat ID, set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env vars.*
4. **Journal + risk banners** — journal screens, risk module + tests, export/import.
5. **Digest + YouTube** — digest screen, calendar + news + YouTube RSS integration, followed-channels settings.

## 6. Risks / caveats

- **Yahoo endpoint is unofficial** and may change or add auth without notice; isolated in one adapter, LSE coverage degrades gracefully. If it dies permanently, the paid-free alternative is Twelve Data's free tier (revisit then).
- **15-minute cadence** means alerts can be up to ~15 min late — acceptable for swing trading per the brief, stated honestly in UI copy.
- **RVOL intraday approximation** documented above.
- **Netlify free tier** limits (125k function invocations/month) are comfortably above expected usage (~10–15k/month); the runlog makes usage visible.
- **This app informs, it does not predict.** UI copy must never imply predictive power or promised returns.
