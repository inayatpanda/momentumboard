# MomentumBoard Stages 4–6 — Journal, Digest, AI Read (combined plan)

> Executed inline, continuously (user: "continue through all the stages without stopping"). TDD for all logic; browser verification at the end; ONE batched CLI deploy.

## Stage 4 — Journal + risk banners + portfolio feedback loop

- `shared/journal.ts` (TDD): `Trade` type (symbol, direction long/short-via-inverse, instrument stock|etp, leverage, riskClass, playbook R/B/A/S, fromSuggestion, units, entryPrice, stop, positionValue £, thesis, openedAt, closedAt?, exitPrice?). P&L model: user logs the INSTRUMENT's own prices (an inverse/leveraged ETP's own price already embeds direction+leverage), so `pnl = (exit−entry)/entry × positionValue`. `computeStats(trades)` → realizedPnl, winRate, avgWin, avgLoss, byPlaybook expectancy. `exposureWarnings(open, capital)` → breaches of 20% position cap, 30% leveraged-ETP cap, 2%/1% risk-per-trade, ETP held >5 trading days (decay), ISA reminder on ETPs. Warn, never block.
- `db.ts` v3: `trades` table; `settings.capital` (default 5000) now feeds the calculator, mirror, and banners.
- `netlify/functions/portfolio.mts` (TDD): PUT (x-app-token) stores snapshot in Blobs `portfolio`; GET accepts x-report-token OR x-app-token → JSON for the morning routine.
- `src/screens/Journal.tsx`: open positions (with live-ish P&L using watch quotes when available), closed trades, stats row, warning banners, add/close forms; snapshot mirrored (debounced) on every change.
- Enable Journal tab. AFTER SHIP: update morning routine prompt to fetch `GET /api/portfolio` (x-report-token) first.

## Stage 5 — Digest + Settings

- `market-data` additions (TDD): `type=calendar` (Finnhub earnings next 14 days filtered to `symbols` param, cached 6h); `type=feed` (general headlines via lib/news + videos via lib/youtube using the server-stored config channels, cached 10 min).
- `src/screens/Digest.tsx`: last-session watchlist performance (sorted from live rows), earnings for watchlist, headlines, videos, morning-report link card, QuiverQuant + external economic calendar links.
- Settings section (on Digest): capital editor; followed-channels editor (add by @handle — `type=resolve-channel` fetches the channel page server-side and extracts `channel_id`); stored in Dexie settings, included in config mirror (replacing the hardcoded DEFAULT_CHANNELS/5000).
- Enable Digest tab.

## Stage 6 — AI read

- `netlify/functions/ai-insights.mts` (TDD): GET (x-app-token). Reads server config + cached quotes/candle-derived setups + recent headlines → compact prompt → **Gemini** (`GEMINI_API_KEY`, gemini-2.0-flash) or **Groq** (`GROQ_API_KEY`, llama-3.3-70b) — whichever env var exists, Gemini preferred. Response cached 30 min in Blobs. Graceful `{unconfigured:true}` when no key. Output copy MUST carry: "AI interpretation — not a prediction, not advice."
- Digest "AI read" card; `/api/ai` redirect.
- User action needed later: `netlify env:set GEMINI_API_KEY <key>` (or GROQ_API_KEY).

## Wrap-up
Full suite + build → browser-verify journal/digest at 390px → merge → push → ONE deploy → prod smoke → routine prompt update (portfolio fetch) → memory.
