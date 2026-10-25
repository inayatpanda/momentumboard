# StreetSignal

Stock research with a stocks-first interface, daily market context, sector
discovery and source-linked findings from tracked YouTube channels.

[Open StreetSignal](https://thestreetsignal.rqai.co.uk/app/)

## Application

- **Stocks:** watchlists, company search, sector browsing, independent strategy
  choices and market activity.
- **Today:** the daily research board and changes in market conditions.
- **The street:** channel insights, searchable video analysis and visible
  discovery/transcript/analysis coverage.
- **Track record:** forward outcome tracking and evidence about past forecasts.

The research engine considers business quality, drawdowns, price trends and
market context. Experimental strategies and social claims are evaluated against
later outcomes; a discussion or price drop is not evidence of a future return.

## Development

Node.js 22.12 or later is required. Cloud jobs use Node.js 22.

```sh
npm ci
npm run dev
```

The development server serves the client. Live market data, authentication and
background processing require the corresponding backend configuration.

```sh
npm test -- --maxWorkers=2
npm run build
node scripts/check-budgets.mjs --enforce
```

The initial client dependency closure has a 100 KB gzip target and a 120 KB
enforced maximum.

## Security checks

The `verify` workflow runs the web tests, build, bundle limit and dependency
audits for both the web app and optional Electron shell. GitHub dependency
alerts, secret scanning and push protection are enabled for this public repo.

As of 25 October 2026, both npm audits report zero known vulnerabilities.
One separate Rust advisory remains in the optional Tauri Linux dependency
chain: `glib` 0.18.5 (GHSA-wrw7-89jp-8q8g). Tauri's GTK3 dependencies require
the 0.18 family; forcing glib 0.20 would break that dependency graph. This is
not part of the deployed website or GitHub video processing. Keep the alert
open until a compatible upstream fix is available; see
[Tauri's upstream discussion](https://github.com/tauri-apps/tauri/issues/16264).
The Electron dependency update does not update previously installed desktop
binaries; those need a newly built installer. This release deploys the web app.

## Services and background processing

### Independent strategy choices

**Stocks → Strategies** (`/app/stocks?view=strategies`) shows one strategy's
current stock matches, sector filters and historical results at a time. The 12
rule sets are shared between the historical test and daily scan. The separate
forecast models in Today and stock research also show one model at a time;
there is no combined recommendation score across these lists.

The `financial-refresh` public-runner workflow refreshes SEC facts and current
strategy choices daily at 13:35 UTC and weekdays at 22:35 UTC. It reuses the SEC
downloads, retrieves two years of free daily stock and sector prices, and checks
only completed sessions. The fixed 55-stock historical sample is scanned first,
then configured US research symbols, capped at 100. Unknown financial sectors,
missing valuations, stale prices and insufficient specialist financial data
remain coverage gaps. They are never assumed to pass a financial screen.

Results are stored in `engine-strategy-choices` and served through the narrow,
authenticated `/api/engine?view=strategies` view. A total price outage preserves
the previous snapshot; the UI hides choices from scans older than 48 hours.
`engine-strategy-choice-history` retains up to 90 first-published session/rule
snapshots for future evaluation. These ungraded selections do not become
historical predictions or change the sized trading board. The historical study
continues to disclose its fixed-sample survivorship bias and uncertainty.

No paid data or model call is added by this scanner. It runs without the
owner's Mac. Run `financial-refresh` manually to publish a fresh scan; the app's
update button retrieves the latest published results and does not launch a job.

### Hosting and video processing

The React/Vite client and API run on Cloudflare Pages, with D1 storage and a
separate scheduled Worker. Shared backend handlers also run in GitHub Actions
for the daily paper and longer background jobs.

Scheduled jobs use standard GitHub-hosted runners. These runner minutes are
free for this public repository under GitHub's current billing rules. Workflow
jobs are restricted to the original repository's `main` branch; forks must
configure their own services and adjust those guards. Production credentials
are stored as repository secrets, never in the source.

The `youtube-capture` workflow runs every three hours (at seven minutes past,
UTC; GitHub may delay scheduled runs). It checks up to 12 pending videos, tries
captions through two free paths, then downloads audio with yt-dlp and transcribes
up to two videos with whisper.cpp on the CPU. Live broadcasts, videos over 90
minutes and audio over 120 MB are skipped. Each audio attempt has a 12-minute
deadline; capture has a 30-minute processing budget. Failures retry after 3–24
hours rather than disappearing. The optional Mac collector can fill gaps when
its host is awake; the cloud workflow does not require it.

Words and timestamps go directly to the existing D1 transcript store. A following
job analyses saved transcripts through the existing DeepSeek integration and
publishes source-linked findings in **The street → Videos**, channel picks and
stock research. **The street → Tracking** shows cloud progress, blocked access
and discovery/transcript/analysis coverage. Existing analysis limits still apply.
If the primary text service fails, the new cloud lane can use the existing
Groq/Gemini text integrations for at most two transcript sections per day,
after 08:00 UTC so it cannot take the morning paper's first claim on free quotas.
Long videos can therefore take several runs or days to finish.
No Supadata subscription, cookies or paid proxy is used by this workflow. Audio
is temporary; transcripts and audio are never uploaded as public Actions
artifacts. Only the speech engine and model are cached.

YouTube can block datacentre IP addresses, including GitHub runners. This is
best-effort capture, not a guarantee of every video. The workflow records blocked
access honestly and retains unfinished work. Captured transcripts are reused.
GitHub can disable public-repository schedules after 60 days without repository
activity; a stale check-in in Tracking exposes a stopped or delayed schedule.
Manual runs also offer a standard GitHub-hosted Mac runner for testing capture;
this is a remote machine and has no dependency on the owner's Mac.

Public runner minutes do not include external API costs, paid transcript
services, larger runners or excess storage. The current capture preference is
free access with gaps and slower processing accepted.

### Direct cloud video reads

`youtube-native-capture` checks the followed channels every hour at :37 UTC.
It uses independently saved captions first, with checkpointed analysis of every
text section. When captions are absent, Google's supported YouTube URL input
reads consecutive ten-minute sections. Each section is saved before publishing;
later runs continue from the saved offset, including beyond the previous
20-minute cutoff. Channels take turns, with unfinished sections preferred within
a channel. Known live/upcoming/incomplete sources wait for a later run.

The observed free project allows 500 requests/day, 15 requests/minute and
250,000 input tokens/minute. Google documents eight hours of YouTube input/day.
StreetSignal reserves no more than **seven hours of requested video sections and
400 requests per Pacific calendar day**, leaving some capacity for the other app
sharing the project. Calls are spaced by at least 65 seconds, and a run makes at
most six new calls. Text-only caption analysis uses requests but no video minutes.
These are conservative application budgets, not a guaranteed throughput. Failed
attempts count; provider quota errors pause calls for an hour. Unfinished work and
retry delays persist. Repeated source failures are surfaced for attention.

New reads **fail closed** unless `YOUTUBE_FREE_TIER_CONFIRMED=true` is configured
as a repository variable and `GEMINI_YOUTUBE_FREE_API_KEY` is present as a
repository secret. There is no fallback to the app's ordinary Google key or any
paid service. `YOUTUBE_NATIVE_SCHEDULE_ENABLED=true` enables the hourly schedule.
The approved project's billing remains disabled. Manual verification uses the
same production queue, concurrency group and daily budget, not an extra quota.
Manual dispatch defaults to `cached_only=true` to republish saved results without
new API calls.

The app distinguishes all sections processed across a known source duration,
an AI-reported ending with unconfirmed duration, and a partial read with further
sections queued. All model-transcribed words remain unverified even when every
section has been processed. Source metadata and quota availability can prevent
full coverage; no successful read promises that every future upload will work.

Findings appear in **The street → Videos**, with an expandable AI transcript,
source link and explicit verification status. Model-transcribed quotes are not
independently matched captions, so they do not enter verified consensus or
forward outcome tracking. Tracking shows whether new free-tier reads are
configured, the last publication result and quota limits.

Validation on 20 October 2026:

- Current yt-dlp plus its recommended PO-token provider was blocked by YouTube
  login checks on both standard Ubuntu and hosted macOS runners. No new audio
  was downloaded in those tests.
- Google's current native video model returned 892 characters and seven stock
  findings for a newly published 52-second video, `yu_qOM9D9l0`, which had no
  saved transcript. The source page confirmed the duration, but the words have
  not been independently checked.
- [The publication run](https://github.com/inayatpanda/momentumboard/actions/runs/39472682865)
  reused that saved draft with zero transcription calls. It confirmed the exact
  video, seven findings and transcript metadata through the live app API.
  The video card and expanded transcript were also checked in the live UI.
- A separate key in a billing-disabled project was subsequently configured.
  [The free-key read](https://github.com/inayatpanda/momentumboard/actions/runs/39479384400)
  processed `fFViVGv5VQ4` directly as video input and saved 8,747 characters.
  A caption transcript already existed, but was not passed to the model.
  [Publication](https://github.com/inayatpanda/momentumboard/actions/runs/39479849835)
  then added a new DAL finding and confirmed it through the live app API and UI.
- The first free automatic run encountered an upcoming broadcast (403) and a
  long recording (503). Input length was reduced from 90 to 20 minutes and
  availability checks were added. Successful examples do not establish that
  every channel or video will work. The initial proof on the app's original
  key did not establish that original key's free-tier status.
- A source review of the 13-minute Verified Investing example showed its trade
  conclusion after minute 10. The initial limit was raised to 20 minutes. The subsequent resumable
  implementation removes that cutoff and continues through later sections.
- [The resumable free-key test](https://github.com/inayatpanda/momentumboard/actions/runs/39485304728)
  published the first two consecutive ten-minute sections of Meet Kevin's
  `kV3MsBAh79Y` into the production API. The third section returned 503; the
  saved offset remains 1,200 seconds with a retry delay. This is a verified
  partial read, not proof that the whole recording was transcribed.
- [The multi-channel run](https://github.com/inayatpanda/momentumboard/actions/runs/39485323603)
  also published caption-based results for Stocks with Josh's `yu_qOM9D9l0`
  and Meet Kevin's `60x34IYK2XM`. Both appeared in the production Videos view;
  the Josh video showed all its transcript sections processed with timed source
  segments. Only claims that actually match source evidence are labelled matched.
- A deterministic 31-minute recording test processes all four sections across
  two runs and verifies that later claims survive without repeating completed
  calls. Live full-length coverage of the long Meet Kevin recording remains
  pending after the provider error. The UI exposes partial coverage directly
  on video cards and provides a mobile refresh control; its research cache now
  expires after one minute rather than fifteen.

See [engine and processing notes](docs/ENGINE_V2.md) for implementation details,
validation history and current limitations.
