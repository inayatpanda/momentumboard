# StreetSignal

Stock research with a stocks-first interface, daily market context, sector
discovery and source-linked findings from tracked YouTube channels.

[Open StreetSignal](https://thestreetsignal.rqai.co.uk/app/)

## Application

- **Stocks:** watchlists, company search, sector browsing and market activity.
- **Today:** the daily research board and changes in market conditions.
- **The street:** channel insights, searchable video analysis and visible
  discovery/transcript/analysis coverage.
- **Track record:** forward outcome tracking and evidence about past forecasts.

The research engine considers business quality, drawdowns, price trends and
market context. Experimental strategies and social claims are evaluated against
later outcomes; a discussion or price drop is not evidence of a future return.

## Development

Node.js 22 or later is required.

```sh
npm ci
npm run dev
```

The development server serves the client. Live market data, authentication and
background processing require the corresponding backend configuration.

```sh
npm test -- --maxWorkers=2 --minWorkers=1
npm run build
node scripts/check-budgets.mjs --enforce
```

The initial client dependency closure has a 100 KB gzip target and a 120 KB
enforced maximum.

## Services and background processing

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

See [engine and processing notes](docs/ENGINE_V2.md) for implementation details,
validation history and current limitations.
