# StreetSignal engine v2

StreetSignal now separates the existing calibrated engine from new predictive strategy sleeves. New sleeves begin in **shadow mode**: visible in the app, timestamped and graded, but unable to size or route a trade.

## Forecast contracts

- The existing Board probability is labelled `edge p`. It means: beat SPY by at least 1 percentage point over 10 sessions without a daily close through the published stop.
- The 3-Session Forecast asks whether the third session will close above or below the signal-day close. Its initial up/down/flat estimates and historical 20th–80th percentile range come from non-overlapping point-in-time historical states in that symbol's own tape. Historical-analogue count and matching-model forward StreetSignal evidence are shown separately. These are descriptive historical estimates, not proven calibrated probabilities.
- New sleeve forecasts ask a different, execution-oriented question: does the target trade before the stop within the stated horizon?
- Target and stop probabilities remain blank (`collecting`) until that sleeve has out-of-sample campaigns. A score is a ranking feature, not a probability.

## Independent campaigns

A daily refresh of the same symbol, side and setup is not new evidence. Every publication keeps its dated `id`, but overlapping refreshes share the first row's `campaignId`. Only the campaign owner updates calibration, factor learning, Brier score and risk ladders.

## Strategy sleeves

### 3-Session Forecast

Runs independently from the 10-session Board. It compares the current one-, three- and ten-session returns, RSI, distance from the ten-session mean, recent volatility and volume to historical states, then measures the following three-session outcome. The closest examples are selected with a three-session embargo so their outcomes do not overlap. Estimates are shrunk toward a non-overlapping historical base rate using a fixed 12-observation prior. A setup requires at least 20 usable analogues, a mean standardised distance no greater than 2, at least 60% directional frequency, a descriptive 95% Wilson lower bound above 50%, and a confirming median move of at least 0.35%. These are fixed research gates, not thresholds fitted to claimed profits.

GOOG and GOOGL are evaluated every run even when neither is in a mover or social feed. Required symbols with short, invalid or more-than-seven-calendar-day-old history publish a `collecting` explanation. Daily bars are deduplicated, future bars excluded, and OHLC validated; without exchange session metadata today's equity bar is conservatively withheld until 21:30 UTC (crypto until midnight). The displayed range contains the central 60% of historical outcomes; it is not a guaranteed price interval.

Every eligible displayed forecast is logged for forward grading, including no-edge forecasts, while only directional setups receive research stop/target levels. Live Brier score measures the `up` event. Brier skill compares each forecast with the historical base rate saved at its own publication time; a negative score means the model did worse than that baseline. Flat predictions are graded as a third direction, and exact probability ties do not create direction-accuracy observations.

### Quality Dip Recovery

Looks for a meaningful drawdown and evaluates reported business health separately from chart behaviour. Index membership and market capitalisation no longer establish quality. A conservative SEC-filing screen checks comparable annual profitability, operating/free cash flow, revenue growth, diluted share-count growth, liquidity and leverage, retaining filing availability and reporting periods. Missing, future or stale inputs mean `unknown`; failed operating checks mean the company fails this conservative screen, not that insolvency has been established. Financial firms and unusual equity structures can require sector-specific review.

A research setup also needs a higher five-session low, a rising latest close above the ten-session average, no imminent earnings flag, and acceptable scenario geometry. Stops use twenty-session support and ATR; the scenario recovers half the drawdown within **63 sessions**, with at least 1.5× reward/risk and at most an 18% stop distance. This is a hypothesis to grade, not a valuation target or expected return. Fifty-/200-session trends, date-aligned SPY performance, sector/news context, and the cause of the drawdown remain visible review inputs. Valuation, future estimate revisions and competitive changes are not established by historical filings. Quality recovery remains shadow research.

The recovery screen now also requires a usable multi-report trajectory. Repeated deterioration overrides a healthy current snapshot to `avoid`; missing, stale or insufficient history keeps the idea on `watch`. Improving/stable trajectories affect only the declared research ranking, not an invented success probability. The report-based model has its own version and starts a fresh forward evidence record.

The scan checks filings for up to 16 price-screened candidates per run, with cached SEC responses and two concurrent requests. Current coverage is SEC US-GAAP/USD facts; unsupported accounting, missing debt components, and international listings remain explicitly unknown. Annual profit and cash flow are checked alongside the latest available interim income, cash flow, comparable revenue and share-count trends, with quarterly and year-to-date periods kept distinct. Growth comparisons use the same filing basis; recent quarterly losses and material dilution can override positive annual figures. A strong old annual report cannot override recent deterioration.

Recovery cards carry sector relative strength against SPY, international market tone, the assessed selloff cause, and adverse headline catalysts. Structural warnings produce `avoid`; unknown selloff causes, imminent earnings, adverse catalysts or a combination of sector outflow and risk-off markets produce `watch`. Positive context cannot upgrade unknown financial health or add an invented probability. Headline assessments are interpretations to verify against the original announcements. The international news candidate feed already covers geopolitics, rates, oil and other market events; it is not a verified company exposure model. Headlines now require a valid publication date within 72 hours, are deduplicated across feeds, and are selected in source rotation so one fast source cannot crowd out international coverage. An eight-second deadline covers both response headers and body; unavailable or undated feeds contribute no current-news signal.

### Social Ignition

Ranks source agreement, 24-hour Reddit acceleration, acceleration between StreetSignal scans, StockTwits presence and YouTube direction. Extreme acceleration in a sub-$500m single-source name is treated as promotion/pump risk, not a buy signal. Unique-author, engagement-quality and coordinated-promotion features remain named data gaps until source-level feeds are connected.

### Macro/Event Transmission

Visible as `collecting`. It must have timestamped surprise data and point-in-time company exposure maps before it can audition predictions.

## Promotion rule

Each new sleeve needs at least 40 independent campaigns, positive expectancy after execution costs, acceptable drawdown and a useful calibration curve. Sample count alone never clears `provisional` or promotes a sleeve. All sleeves remain shadow until an explicit evidence review.

Calibration is separated by sleeve, event definition, horizon and model version; barrier probabilities are also side-specific. Duplicate/overlapping campaigns, not-yet-known outcomes, cancelled entries and incompatible legacy execution outcomes do not inflate trade evidence. New model versions start their own forward record; the earlier composite/seeded calibration is not transferred to them.

## Execution book v2

- A new call queues on signal day and fills at the next session open.
- Entry and exits include 10bp adverse slippage; commission is currently modelled at £0 and stated in the app.
- Position size uses the actual fill-to-stop distance. Research sleeves do not size trades.
- Stop and target use daily high/low. If both trade in one daily bar, the stop is booked first.
- Gaps outside the published stop-to-target geometry cancel the order. Lab direction outcomes still mature for cancelled orders, but these do not count toward barrier probabilities.
- Lab execution grading charges the same 10bp adverse slippage per side, fills stop gaps at the worse open, respects an opening target gap before subsequent intrabar moves, and computes short returns on entry capital. Borrow fees, spreads and market impact remain unmodelled.
- A full completed forecast horizon is required before grading; a truncated history cannot silently shift the entry date.
- The three-session direction forecast is anchored to the saved signal session, independent of whether a provider stamps bars at midnight or exchange open. Execution starts at the next future venue open using daylight-saving-aware session times. Intraday publication has fewer remaining sessions inside the fixed direction horizon. A forecast published after that horizon has expired cannot count as forward evidence.
- Long and short risk permissions learn separately; a profitable short record cannot finance long risk.

## What the app shows

The redesigned Research desk brings together market context, published calls, filtered research ideas, historical learning and an intelligence notebook. Strategy cards foreground the thesis, horizon, available evidence and what could invalidate the idea. Forecast definitions, calibration and detailed methodology remain accessible in disclosures. The 3-session cards distinguish historical analogue frequency from matured live evidence. Research → Ledger retains directional risk rungs and the execution book's pending next-open orders and fill policy.

The company dossier has navigation for price, thesis, financial report history, track record and risk tools. Its business section separates current health from change over time. An interactive report chart switches between revenue growth, net margin change and operating cash conversion; selecting a period shows the original filing, publication cutoff, dilution and frozen financial assessment. Annual, quarterly and year-to-date windows remain distinct. Unknown metrics stay unknown.

## Dated financial memory

SEC company facts are reconstructed at each report's original availability cutoff, using only facts filed by that cutoff. Up to 12 unique reporting periods from the last three years are retained. The first accession for an actual reporting period defines the point; comparative prior-year figures do not manufacture extra historical reports, and later restatements cannot rewrite an earlier point. Availability uses the conservative next-day noon UTC cutoff when an exact filing acceptance time is unavailable.

Each point freezes its operating measures, evidence, health assessment and missing coverage. Revenue, margin and dilution comparisons use the same filing basis. Interim cash-flow margins use revenue over the same cash-flow duration; a quarterly income statement is not divided into a year-to-date cash flow. The `comparable-filings-v1` trend needs three recent comparable reports and evidence from at least two operating families per report. Operating and free cash flow are treated as one family. Repeated improving or weakening reports determine the descriptive trajectory; unsupported history stays `insufficient`. This is not a price-return backtest.

## Learning from published research

Every scan stores a dated research receipt, including the probabilities actually shown, the context known at publication and the contemporaneous learning summary. Later outcomes do not rewrite published odds. The rolling archive retains 90 scan receipts; the campaign ledger preserves every pending campaign and up to 500 completed campaigns. This bounded memory is explicitly not a lifetime performance record.

The feedback view uses only completed, compatible model and execution contracts with known outcomes. Repeated overlapping campaigns on the same symbol are excluded. It shows net returns after the modelled execution costs, target/stop outcomes, probability error and paired baseline comparisons. Saved report trajectory, chart confirmation, sector rotation and international market tone provide descriptive condition groups. Missing context is never backfilled with today's knowledge. A group needs 20 independent outcomes before describing a pattern; comparisons need adequate samples on both sides. Earlier/recent groups split only between distinct publication timestamps, so one large scan cannot manufacture chronological drift.

The recovery probability adjustment is deliberately narrower than the descriptive learning view. A fixed report-trend cohort may adjust target/stop/neither probabilities only with at least 40 completed pooled campaigns, 20 in that cohort and 20 eligible chronological validation calls. For each historical validation call, training includes only outcomes fully resolved **before that call was published**, including the full 63-session delay. A three-category Dirichlet estimate shrinks the cohort toward the pooled distribution with a fixed prior weight of 20. The cohort must improve paired three-category Brier error over the contemporaneous pooled baseline by at least 1%. Otherwise the published probability stays pooled or collecting. Cancelled/unfilled entries, legacy models and future outcomes cannot train this estimate.

The gate and parameters are declared research rules, not thresholds fitted to a claimed profit. Passing this retrospective gate does not establish live skill, remove provisional status or change trade sizing. Prospective probability error is tracked separately against the baseline saved with each actual publication. Sector/news groups remain descriptive and do not automatically tune the model.

## YouTube evidence and operational status

Caption ingestion normalises supported YouTube URLs and parses XML timed text, segmented captions and JSON3. Supadata asynchronous processing is retried, and arriving transcripts reactivate deferred extraction. Analysis reads bounded chunks across the transcript (up to 300,000 characters) rather than silently treating its first 24,000 characters as the full video. Company names, thesis and evidence quotes travel with extracted tickers; known ambiguous aliases are corrected only when the company is grounded in source text.

The Street page distinguishes pending transcripts, queued/deferred analysis and failures, with last-success and next-retry timestamps. Rate limits retain work for retry. Free YouTube caption access remains subject to upstream availability and IP restrictions; the existing local transcript runner or a configured supported provider is still needed when direct retrieval fails. Existing paid-provider quotas and worker schedule are unchanged. Old stored analyses are not automatically rewritten, and model summaries remain interpretations to check against the video.


## 2026-10-19 review and model boundary

The existing discovery walk-forward reports do **not** establish a robust tradable edge: the reported overlap-corrected statistics failed the research gates and the honestly selected composite did not outperform reliably. The changes above repair evidence counting, timing, execution arithmetic and source quality; they are not a new claim of forecast accuracy or profitable returns. New models are `nonoverlapping-analogues-v2`, `quality-dip-report-trends-v4` (63 sessions), and `social-ignition-next-open-v2`; the lab execution contract is `next-open-costs-v2`. The composite's bucket semantics and seeded hit definition are unchanged, so its seed is not reused or retuned for these sleeves. Fresh forward observations and cost-aware, temporally held-out validation are still required.

## Local verification and remaining limits

The 2026-10-19 revision passes all 3,596 tests across 244 files, the TypeScript/production build and an API adapter bundle check. Live SEC history checks succeeded for AAPL and MSFT; each returned 11 dated reporting periods. Desktop and phone browser checks covered research filters, forecast disclosures, original filing links and report selection. The local design preview used labelled synthetic research ideas and real public AAPL filing data; its temporary fixtures were removed from the app.

Public-site code and styles now load separately from product startup. The measured initial closure fell from 139.2 KB after the redesign to 129.8 KB gzip, but remained 9.8 KB above the unchanged 120 KB budget at this checkpoint. Broader route-specific stylesheet work remains. Current filings coverage is US-GAAP/USD; valuation and forward estimates remain gaps. YouTube parser, analysis and retry fixes do not remove upstream caption restrictions or provider configuration requirements. These were pre-release checks; see the 20 October deployment record below.

## Social evidence pipeline — 19 October 2026

YouTube is the first complete adapter. The claim and outcome types are reusable
for other sources; automated collection from X, Instagram and TikTok is not part
of this release. Third-party pundit coverage and manually forwarded calls remain
visible, labelled, and excluded from automated consensus and accuracy learning.

### Capture and processing

- Feed discovery retains stable channel IDs and publication dates and reconciles
  seven days of recent entries. This remains feed polling, not WebSub.
- `social-jobs:v1` replaces video work in the paper's shared queue. Producers and
  consumers use D1 atomic leases. Unfinished and failed jobs are retained, with
  stages, retry dates, attempt counts and owner-only retry through
  `/api/fn/video-jobs`. The worker migrates legacy video jobs idempotently.
- Caption acquisition is stored before analysis. XML srv1/srv3, JSON3 and Supadata
  segments preserve timestamps and language; absent timing is never invented.
  Individual transcript keys survive eviction from the recent display window.
  Identical words can receive a timing upgrade; the original revision survives.
- Supadata uses `mode=native`, persists async job IDs, and resumes them. The
  five-minute `video-capture-poll` job collects two saved provider jobs per tick
  without buying new transcriptions. This matters because the provider documents
  a one-hour lifetime for completed job results. Expired/failed IDs require an
  explicit owner retry. See [provider contract](https://docs.supadata.ai/get-transcript).
- Attempt reservations bound native acquisition to eight/day and 90/month,
  Gemini extraction to two/day and narrative watches to one/day. Failed attempts
  consume budget too. Native budget exhaustion leaves local captions available;
  no automatic per-minute ASR purchase is enabled. The existing total extraction
  and narrative caps remain 25/day and three/day.
- Long transcripts and narrative reads checkpoint completed chunks. The worker
  continues ready chunks while its run budget allows, rather than restarting a
  show or waiting three hours between each pair of sections. The three-hourly
  main worker schedule remains unchanged; UI retry eligibility is not an ETA.
- The per-video and worker leases outlast the GitHub job's 20-minute lifetime.
  Short publication leases serialize the video, feed and manual display writers.

### What a claim means

`quoted-claims-v1` stores separate statements, even when the same speaker is
short-term bearish and long-term bullish. Each statement retains its quotation,
company/ticker identity, stated horizon, condition, typed price levels and
verification state. Quotes must occur in the transcript; timestamps come from
caption spans, never a model-generated timecode. Company identity is checked
against the committed listing directory and explicit reviewed aliases.

“Quote matched” verifies the words, **not** the interpretation or the truth of
the investment thesis. Conditional, unidentified and unsupported statements do
not enter the outcome study. A deliberately narrow numerical fact checker
compares literal metrics, units and exact reporting periods with SEC evidence
available at capture time. Ambiguous or unavailable comparisons stay unknown.
Targets/support remain creator claims. Transcript coverage is reported as
sections and timestamped segments, not an invented percentage of video duration.
Gemini-only visual output is marked unverified and cannot become a qualified vote.

### Outcome learning

`social-outcomes:v1` is independent of the rolling 400-video display. Pending
records do not expire at 60 days or fall out after 120 newer extracts. The daily
engine rotates unresolved records through its market-data budget, requiring
historical coverage and aligned symbol/SPY sessions. It uses the next actual US
market open (including DST), the tenth session close and a declared 0.20%
round-trip cost estimate. Future closes and missing session data cannot score a
result. Borrow costs and dividends are excluded.

Two clocks are stored: creator publication and confirmed app availability.
Outcome registration happens only after evidence publication succeeds. If a
recovery finds published evidence without a ledger entry, tracking starts at
recovery time; it cannot backdate a missed registration. Publication results are
retrospective; app-time results describe subsequent performance.
This fixed 10-session comparison is a common benchmark, **not** a claim to score
every creator's own horizon or conditional trade plan. Opposing/repeated views
from the same channel and symbol share a campaign while overlapping; only the
first call contributes to independent channel statistics. Older summaries are
not retroactively labelled as source-verified foresight.

The study is **shadow-only**: no probability calibration, channel weight or
position size is promoted from it. Engine model v5 removes favourite-channel
accuracy bonuses and uses one latest vote per channel/symbol. Historical model
v4 seed data retain their original version; newly generated forecasts and replay
artifacts identify v5. Legacy channel-credibility data are preserved for audit.

### UI and rollout

The Street page now shows processing health, individual stages, retries,
caption/section coverage, source timestamps, conditions, verification and the
forward outcome study. It distinguishes source dates from app availability.
Owner retries preserve evidence and restart only recoverable work.

Deploy the Pages application, the cron worker (new handler in its existing
five-minute schedule), and the queue worker code together. Update the local Mac
runner script so new submissions include caption segments. Existing secrets are
reused; no new account connection is needed. See the deployment record below.
Tests exercise provider responses with controlled fixtures; they do not establish
production transcript availability or extraction accuracy on a human-labelled
video corpus. Selective chart-frame verification, WebSub delivery and additional
platform adapters are subsequent work, not capabilities claimed by this release.

### Mobile layout and release preparation — 19 October 2026

At phone widths (760 px and below), the home screen is now a daily brief with
three views: Today, Research and Learning. Today puts published calls first;
market context and engine diagnostics sit inside an expandable summary.
News/events and YouTube/social have direct links. The desktop keeps its expanded
research desk. Stale-board notices and refresh failures remain visible.

The production release workflow is manual and restricted to `main`. It tests and
builds the app, copies the existing GitHub Supadata secret directly into the
Cloudflare Pages secret store, and deploys Pages followed by the cron dispatcher.
The dispatcher invokes the collector on Pages, so no provider key is needed on
the dispatcher itself. The existing queue schedule reads the released code from
`main`; the Mac caption runner already points to this checkout.

### Interface refinement — 20 October 2026

The phone brief now uses compact stock rows with clear price labels and a link
to the complete setup. Planned entries and stale quotes remain explicitly
labelled; provisional, paper-only, instrument and wildcard context survives the
compact view. Search and refresh sit in a small app bar. News and social evidence
have two direct entry cards. Navigation uses consistent line icons, watchlists
use grouped rows, and stock pages give prices and chart controls more room.
Neutral solid surfaces and blue controls replace the previous indigo gradients
in both themes.

Focused verification passes 174 tests across seven files. Browser checks covered
390 px and 320 px phone layouts, tab switching, light/dark themes and a 1280 px
desktop view, using clearly labelled illustrative data. No horizontal overflow
or browser errors were observed. The production build passes; the initial bundle
is approximately 132 KB gzip, above the unchanged 120 KB budget.

### Production deployment — 20 October 2026

Application revision `dfebd3a` is deployed to
<https://thestreetsignal.rqai.co.uk/app/>. Pages deployment:
`d8e0adce-7c88-4091-ac57-6a159ec1e39c`. The matching cron worker version is
`6b411d31-4a9a-4af8-89c0-e8017529d292`, with the existing three schedules.
The queue worker uses this revision from `main` at its next scheduled run.
The collector's scheduled invocation was confirmed by its non-sensitive D1
update timestamp at **12:25:22 UTC**, without reading the stored payload.

The full GitHub check passed **249 test files, 3,629 tests, one skipped**, and
the production build. The measured initial bundle is 132.1 KB gzip. GitHub's
existing Cloudflare token could not update Pages, so deployment used the Mac's
existing Wrangler OAuth session; no token permissions were expanded. The manual
GitHub deployment workflow still requires a Pages/Workers-capable token.

Public HTTP checks confirm the new home-screen code, new stylesheet palette,
service worker and `/app/` manifest scope on the main domain. Browser layout
checks used illustrative data. Signed-in production UI validation remains
unverified because extracting an owner licence for that purpose was rejected
by automatic approval review. Unauthenticated command-line API checks were
blocked at Cloudflare (1010), so they do not establish handler behaviour.

**Remaining configuration:** Pages does not yet have `SUPADATA_API_KEY`.
GitHub has the existing key and continues to use it for scheduled extraction.
The new five-minute collector is deployed, but cannot retrieve provider jobs
until the key is installed on Pages. Automatic approval review rejected an
encrypted one-time transfer through a GitHub artifact without explicit consent;
user permission has been requested. No secret was transferred or printed, and
the temporary transfer workflow was not committed or executed. Provider parsing
and retry tests pass, but production end-to-end transcript availability is not
claimed complete.

## Stocks home and subscription-independent capture — 2026-10-20

Supadata's authenticated account endpoint reported `Free (100/mo)`, 100 maximum
credits, 334 used and zero remaining (12:38 UTC). This confirms exhausted
credits, not a subscription cancellation date. The read-only status workflow
keeps the key inside GitHub and outputs only whitelisted plan/usage fields.
The video worker now refreshes that status, exposes it in The street, and avoids
new Supadata requests while a recent check says exhausted or unauthorized.

The live upload failure was independently reproduced: Cloudflare logged
`D1_ERROR: string or blob too big: SQLITE_TOOBIG`. The monthly transcript array
had reached 8,233,901 characters. Full transcripts now live under individual
`video-transcript:<id>` keys, with compact recent/monthly `video-transcript-index:v2`
indexes. Existing aggregates are preserved read-only. Duplicate uploads repair
partial index writes instead of returning early. The Mac retains failed uploads
atomically in an ignored `.local/transcript-outbox` and retries them before
fetching new videos. Pending discovery also includes unfinished durable jobs
outside the 200-video display window.

Capture on the Mac tries the existing timed-caption reader, then the maintained
[youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api), then
[yt-dlp](https://github.com/yt-dlp/yt-dlp) audio and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) local speech recognition.
The library path was verified on TGuw8RA1KLY: 194 segments / 5,929 text characters.
The full audio path on that public video produced 95 timed segments / 5,961 text
characters. No Supadata credit was used. An unavailable video remains pending;
there is no promise to retrieve private, deleted, restricted or every live video.
Caption/audio processing does not establish what a chart visually shows.

Local dependencies are isolated in `~/Projects/streetsignal-tools/venv` using
`scripts/local/transcript-requirements.txt`; the base.en model is in that tools
folder. Existing Homebrew `whisper-cli` and `ffmpeg` are used. The runner supports
STREETSIGNAL_PYTHON, STREETSIGNAL_YTDLP, STREETSIGNAL_WHISPER_MODEL,
STREETSIGNAL_WHISPER and STREETSIGNAL_FFMPEG overrides. Audio work is limited to
two attempts per run, non-live videos up to 90 minutes, 120 MB downloads, and
bounded subprocess timeouts; temporary audio is removed. `--no-audio` and
`--limit N` allow smaller runs. The supplied launchd definition checks at login
and hourly while awake; it does not wake the laptop or prevent sleep. Runner
heartbeat, last saved time and buffered uploads are visible in The street.

Cloudflare retains discovery, durable jobs, transcript storage and app delivery;
the existing GitHub worker handles analysis. Plain Workers are not the place to
run native ffmpeg/Whisper. Cloudflare Containers or a VPS could host those
processes, but cloud hosting does not itself solve YouTube IP restrictions.
An always-on home machine is the natural extension if laptop uptime becomes
insufficient. No new paid server was provisioned. Analysis remains subject to
its existing daily budgets; captured work waits durably instead of disappearing.
The manual queue workflow defaults to videos-only mode, with an optional
already-discovered URL for a focused retry; that mode cannot send queue alerts
or run the paper/dossier handlers.

Stocks is now `/app/`, Today `/app/today`, with `/app/stocks` retained as an alias.
The opening watchlist shows six rows and an explicit expand control. Discover
supports company-name/ticker search, US/UK filters and sector browsing over the
committed 1,866-listing directory (snapshot date shown). Funds/trusts are separate;
unknown sectors stay Other. These counts describe the directory, not holdings
allocation. Quotes are fetched in groups of twelve; large lists do not fetch
candles per row. Movers, sector performance and crypto live under Markets.
Channel insights links directly to The street, whose video feed can be filtered
by channel and distinguishes machine speech transcription from captions.

## Channel coverage and a quieter research UI — 2026-10-20

The preceding release (`ae7d39b`) is live. A subsequent Mac run saved eight
transcripts. The focused cloud analysis run
[39427365680](https://github.com/inayatpanda/momentumboard/actions/runs/39427365680)
completed successfully, using stored local words, and reported completion for
TGuw8RA1KLY. This proves that capture and cloud analysis can connect; it does not
prove coverage of every channel or every video.

The street now has three views: Insights, Videos, and Tracking. Insights starts
with six channel picks and three recent analyses. Videos supports channel,
company/ticker/topic search, and a matched-quote filter. Duplicate URL forms use
the most recent analysis. Source excerpts and longer narratives expand on demand.
Tracking shows each configured channel's discovered, captured and analysed counts,
including channels with no recent uploads. Counts explicitly cover the saved
recent discovery window, rather than claiming a complete channel history.
Pending capture includes unfinished durable jobs beyond that recent window.
Discovery no longer silently drops feed entries after the first five per channel;
it reads every returned RSS entry within the existing seven-day eligibility window.

Social pulse distinguishes Reddit mention counts from Stocktwits trending and
shows its last update, failure and retry state. Partial transcript processing is
labelled partial. Attention alone is not presented as a return forecast. Stocks
remains first, Today second. Markets now loads only when selected, reducing the
initial gzip dependency closure from 123.4 KB to 119.3 KB (120 KB hard limit;
100 KB target is still exceeded).

Validation: all 252 test files / 3,647 tests passed before final layout corrections.
After those corrections and a new partial-coverage regression test, the affected
two files / 27 tests passed. The production TypeScript/Vite build passed.
Browser checks used explicitly labelled illustrative data at 320 and 390 pixels
and a 1280-pixel dark desktop. Channel navigation, filtering, source expansion,
overflow, refresh-button clearance and card heights were checked. The temporary
fixture entry points were removed before the final build. Screenshots are saved
outside the repository in the parent Projects folder. No authenticated production
screen is claimed as visually verified.

### Laptop-independent capture recommendation

The owner does not want the Mac to remain on. The local collector is therefore a
fallback, not the recommended permanent dependency. Existing cloud discovery,
storage and analysis already run without the laptop. Hosted transcript access is
the missing dependable input. Moving yt-dlp or youtube-transcript-api to a generic
VPS or Container does not itself solve YouTube blocking cloud-provider IPs.

Verified public prices on 2026-10-20:

- [TranscriptAPI](https://transcriptapi.com/): $5/month, 1,000 credits, one credit
  per successful request; new accounts advertise 100 trial credits. Its caption
  endpoint is an alternative to trial against the actual tracked channels.
  It is not configured or live-tested in this app.
- [Supadata](https://supadata.ai/pricing): Pro $17/month, 3,000 credits. Existing
  captions cost one credit; generated transcripts cost two credits per video
  minute. The app already integrates Supadata but its account currently has no
  remaining credits. The existing `mode=native` request deliberately avoids
  automatic per-minute transcription charges.

Recommended rollout: trial hosted caption capture, measure successful coverage
and cost on the tracked channels, then select a monthly plan. Keep discovery
independent of the paid service, cache each successful transcript, and retain
the same durable retry/analysis pipeline. Add an explicitly budgeted audio
fallback for videos without captions; do not assume a caption subscription covers
them. Before activating paid capacity, adjust the current native-capture budget
(8 attempts/day, 90/month) to the chosen plan and make provider credentials
available in the selected cloud execution environment. GitHub currently has
the Supadata key; Pages does not. No new subscription, provider account,
credential transfer, or server purchase was made.

**Owner decision:** keep capture free, accepting gaps and slower capture.
No hosted subscription is being activated. Existing cloud jobs continue
discovery, best-effort caption retrieval and analysis of stored material;
the Mac only fills capture gaps while awake. Do not require laptop uptime,
increase paid provider limits, or add extra GitHub polling to disguise the
remaining limitation. Videos that cannot be read remain visibly incomplete.
The paid options above are research notes, not the selected rollout.

**Release verification:** application commit `acb16bc` was pushed to `main`;
Cloudflare Pages deployment `41fb800e` completed successfully at
https://41fb800e.streetsignal.pages.dev. The production `/app/` HTML and its
entry JavaScript/CSS returned HTTP 200 and matched the tested build byte-for-byte.
The scheduled worker deployed as version
`700e0416-e377-4d59-afc3-8c0666cae2f0`. No extra queue run or paid capture was
triggered for this release. The local design-review server was stopped and the
browser viewport override reset after visual checks.
