# Off Netlify: the Cloudflare Migration — Design

**Date:** 2026-08-12 · **Status:** outage response; owner asked "isn't there a way to run this app out of netlify?" with the site disabled for exhausted credits.
**Data:** the complete blob store is rescued at `~/Documents/streetsignal-blob-backup-2026-08-12/` (2,023 blobs, 45MB, tar.gz alongside; only losses = 11 already-evicted cache keys).

## 1. Why Cloudflare

The app's shape maps almost one-to-one, and the free-tier arithmetic is decisive:

| Netlify (free, exhausted) | Cloudflare (free) |
|---|---|
| Functions ~125k invocations/MONTH | Workers 100k requests/DAY |
| Static hosting metered into the same credits | Pages: unmetered static for this size |
| Netlify Blobs | D1 (SQLite, 5M rows, 100k writes/day) behind the existing `AppStore` seam |
| Scheduled functions (alert-check */5, watchdog, report-kick) | Cron Triggers on the Worker |
| Deploy = push to main | Deploy = `wrangler deploy` / Pages CI — decoupled from git push if we choose |

Alternatives rejected: **Vercel** (same metered-cliff failure mode; hobby cron can't do */5); **Helm behind the tunnel** ($0 and instant, but ties a licensed reader product to this Mac's uptime — acceptable as an emergency read-only mirror, not as the home); **paying Netlify** (~$19/mo — offered to the owner as the instant-restore path; this design assumes we leave).

## 2. Target architecture

- **`thestreetsignal` Worker** (one Worker, module syntax): routes every `/api/*` and `/.netlify/functions/*`-equivalent path to the existing handlers. The `.mts` functions are already `export default async (req: Request) => Response` — the port is a router table plus env plumbing, not a rewrite.
- **D1 database `streetsignal`**: one table `blobs(store TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(store, key))`. A new `d1AppStore` implements the existing `AppStore` interface (`read/write/readStrong` — strong reads are native: D1 is single-primary, which RETIRES the Blobs eventual-consistency machinery). The `cache` store keeps TTL semantics via an `expires_at` column and lazy eviction.
- **Cron Triggers** on the Worker: `*/5 * * * *` → alert-check; `*/15` → watchdog cadence as today; `20 5 * * 1-5` → report-kick. Cloudflare cron fires `scheduled()` — a thin dispatcher calls the same handlers the HTTP router uses (they already validate `next_run`-style bodies; the dispatcher synthesises the equivalent).
- **Pages project** for the Vite app (`dist/`), custom domain `thestreetsignal.rqai.co.uk`. Functions and Pages can share the domain via routes (`/api/*` → Worker).
- **GH Actions pipeline unchanged in role**: queue-worker/composer stop calling the Netlify Blobs API and call a small authenticated `/api/store` endpoint on the Worker (token = existing APP_TOKEN pattern), or D1's HTTP API directly. Secrets move to Worker env (`wrangler secret`) + repo secrets stay.
- **Licences**: the `app` store rows (licence keys, tokens) import into D1 verbatim; `authenticate()` logic is unchanged — readStrong becomes a plain read.

## 3. Migration stages (each gated like every stage before it)

1. **M1 — the store seam**: `d1AppStore` + schema + an import script that loads the rescued backup into D1 (idempotent, checksummed count vs the export manifest). Unit tests against a local D1 (wrangler's miniflare).
2. **M2 — the Worker**: router + env shims + the scheduled dispatcher; every existing function handler mounted; `CANONICAL_SITE` and internal fetch URLs parameterised (they already are via lib/site.ts).
3. **M3 — parallel run (the gate)**: Worker live on `*.workers.dev` + Pages preview, seeded with the imported data; a full synthetic day driven against it (predict → board → paper compose via a manual Actions dispatch → alerts dry-run); diff the board/ledger/paper against a local run byte-for-byte where deterministic. THE GATE: byte-parity on deterministic outputs, all crons observed firing, licence auth verified with a real key.
4. **M4 — cutover**: owner flips the Hostinger CNAME (`thestreetsignal.rqai.co.uk` → Pages), Actions secrets swap, Netlify site stays disabled as the fossil. Rollback = flip the CNAME back (Netlify would need credits to matter again — the true rollback is "pay Netlify", which remains available).

## 4. Risks and their answers

- **D1 write volume**: alert-check writes state/runlog every 5 min ≈ 400-600 writes/day + engine writes — comfortably under 100k/day.
- **Blob semantics drift**: the seam is the same interface the whole codebase + tests already use; the eventual-consistency workarounds (readStrong, token grace) become no-ops rather than hazards.
- **Scheduled-function auth**: the handlers gate on a body marker + admin token; the dispatcher must synthesise a body the handlers accept WITHOUT weakening the public-URL protections (M2 acceptance item).
- **Cloudflare account**: the owner has one (the Helm tunnel runs on it); wrangler auth is the first M1 step and may need the owner's browser once (`wrangler login`).
- **The paper's LLM keys**: move as Worker secrets; GH Actions copies exist already.
- **Two-host confusion**: from M4, netlify.toml and the deploy-on-push coupling are deleted; deployment becomes explicit (`wrangler deploy` + Pages), which also permanently ends the push-equals-deploy hazard this project has been managing around.

## 5. Out of scope

Paying Netlify (owner's call, standing offer); moving rqai.co.uk's nameservers to Cloudflare (nice-to-have, not needed — a CNAME at Hostinger suffices); Helm as anything more than an emergency mirror; any engine behaviour change (Stage 2 continues separately and ships onto whichever host is live).
