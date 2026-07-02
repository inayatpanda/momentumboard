# MomentumBoard Stage 2 — Alert Engine + Telegram Implementation Plan

> Executed inline (user's chosen mode). Leaner format than stage 1: exact files/interfaces/test cases; code bodies written at implementation. TDD per module, commit per task.

**Goal:** 24/7 two-tier alerting: a scheduled function (every 5 min) evaluates price/RVOL/RSI/setup/news/YouTube/regime rules against the Blobs-mirrored config and pings Telegram (instant tier) or batches into thrice-daily digests; the same engine runs in-browser for toasts.

**Spec sections:** §4.1 (config-sync, alert-check, two-tier), §4.2 (rules.ts semantics), §5 (setup transitions). Decisions locked: 5-min cadence 24/7; quote rules only while the relevant market is open; instant = price levels, setup triggers, regime flips, watchlist-ticker headlines/videos; batched digest at 07:00/14:30/21:00 UK; no quiet hours.

## Tasks

### T1: Shared alert engine (`shared/alerts.ts` + tests)
Types: `AlertRule` (`{id, symbol, kind: 'priceAbove'|'priceBelow', level}` — user rules; built-ins are implicit), `AlertEvent {id, tier: 'instant'|'batched', text, symbol?, at}`, `AlertState {ruleArmed: Record<string, boolean>, seenItems: string[], rsiZone: Record<string,'low'|'mid'|'high'>, lastSetups: Record<string, SetupKind[]>, rvolHot: Record<string, boolean>, lastRegime: RegimeColor|null, queue: AlertEvent[], lastBatchAt: number}`, `TickerSnapshot {symbol, price, rvol, rsi, setups, marketOpen}`, `NewsItem {title, url, symbols: string[]}`, `VideoItem {title, url, channel}`.
`evaluateAlerts(cfg: {rules: AlertRule[], watchlist: string[]}, input: {tickers, regime, news, videos, nowSec}, state) → {events, state}` — pure.
Semantics: price rules fire on cross while `marketOpen`, re-arm when price retreats ≥0.5% past level; RVOL fires crossing ≥2 (re-arm <1.5); RSI fires entering >70 / <30 zone (re-arm in 35–65); setup ADDITIONS vs lastSetups → instant for reclaim/breakoutLive/fallingKnife, batched otherwise; regime change → instant; news/video with watchlist symbol in title → instant, else batched; dedupe by url in `seenItems` (cap 500); `flushBatch(state, nowSec, tzOffsetChecker)` → returns digest text when a 07:00/14:30/21:00 Europe/London boundary passed since lastBatchAt and queue non-empty.
Tests: price cross + no-refire + re-arm cycle; closed-market suppression; RSI zone transitions; RVOL hysteresis; setup addition tiers; news dedupe + tier by symbol match; regime flip; batch flush at boundary only, queue clears.

### T2: RSS parser + news/YouTube fetchers (`netlify/functions/lib/rss.ts`, `news.ts`, `youtube.ts` + tests)
`parseFeed(xml): {title, url, publishedSec}[]` — regex-based, handles RSS2 (`<item><title><link><pubDate>`) and Atom (`<entry><title><link href>​<published>`), decodes basic entities, no deps. Fixtures: trimmed real stockmarketloop RSS2 + YouTube Atom.
`fetchNews(symbols, finnhubKey, fetchFn)`: Finnhub `/company-news` (last 24h, per symbol, cap 5) + stockmarketloop `/feed/` + Google News RSS `search?q=stock+market` → `NewsItem[]` with `symbols` = watchlist tickers appearing as word/`$SYM` in title (uppercase match).
`fetchVideos(channelIds, fetchFn)`: `youtube.com/feeds/videos.xml?channel_id=X` per channel → `VideoItem[]` (latest 5/channel). Default channel IDs resolved at build time and stored in shared `DEFAULT_CHANNELS`.

### T3: Blobs app store + config-sync function (`netlify/functions/lib/store.ts`, `config-sync.mts` + tests)
`store.ts`: `readJSON<T>(key)/writeJSON(key, val)` on Blobs store `'app'`, in-memory fallback (same pattern as cache.ts). Keys: `config`, `alert-state`, `runlog`.
`config-sync.mts`: `GET /api/config` → `{ok, data: config|null}`; `PUT` body = `AppConfig {watchlist: {symbol, riskClass}[], rules: AlertRule[], ytChannels: string[], capital: number}` → validated (arrays, ≤30 tickers) and stored; `GET /api/config?view=runlog` → last 20 runlog entries. Same `x-app-token` gate as market-data. Tests via exported `routeConfig(...)` with injected store.

### T4: Telegram + alert-check scheduled function (`lib/telegram.ts`, `alert-check.mts`)
`sendTelegram(botToken, chatId, text, fetchFn)` → POST `api.telegram.org/bot{t}/sendMessage` `{chat_id, text, disable_web_page_preview: true}`; throws on `ok:false`. Test: URL/payload/mocked failure.
`alert-check.mts`: `export const config = {schedule: '*/5 * * * *'}`. Flow: read config (exit quietly if empty) → market-open flags from rvol SESSIONS → parallel: quotes (cache 60s), candles per symbol (cache 900s), news (cache 240s), videos (cache 240s) → build snapshots (rvol/rsi/setups from shared modules) → `evaluateAlerts` → instant events → Telegram (skip+log if env unset) → `flushBatch` → maybe digest send → persist state + append runlog `{at, events, sent, errors[]}` (cap 50). Per-symbol try/catch. Local verify: `netlify functions:invoke` (or curl the function) with `netlify dev`, assert runlog via `/api/config?view=runlog`.

### T5: Client — config mirror, price-rule editor, toasts
- Dexie v2: `rules` table `{id, symbol, kind, level, createdAt}`.
- `api.ts`: `getConfig()/putConfig(cfg)`.
- Watchlist mirrors `{watchlist, rules, ytChannels: DEFAULT_CHANNELS, capital: 5000}` on every add/remove/rule change (debounced 1.5s).
- Card tap toggles an inline editor: "Alert above / below" price inputs → saves rules.
- `useAlerts` hook: run `evaluateAlerts` on each quote poll (client state in Dexie `settings.alertState`), render instant events as toasts (`.toast` stack, auto-dismiss 6s).
- Component test: editor saves a rule; toast renders event text.

### T6: Deploy + activation
Merge → push (verifies GitHub auto-deploy end-to-end) → confirm scheduled function registered (`netlify functions:list`) → runlog shows runs. Telegram activation NEEDS USER: BotFather token → `netlify env:set TELEGRAM_BOT_TOKEN`, then user messages bot `/start`, we read chat id from `getUpdates` → `netlify env:set TELEGRAM_CHAT_ID`. Until then alert-check logs "telegram-unconfigured" and still queues/evaluates.

**Non-goals (deferred):** rule editor in ticker detail (stage 3), YouTube channel management UI (stage 5), PEAD rule (stage 5 calendar), Web Push.
