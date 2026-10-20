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

All workflows use standard Ubuntu runners. These runner minutes are
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
No Supadata subscription, cookies or paid proxy is used by this workflow. Audio
is temporary; transcripts and audio are never uploaded as public Actions
artifacts. Only the speech engine and model are cached.

YouTube can block datacentre IP addresses, including GitHub runners. This is
best-effort capture, not a guarantee of every video. The workflow records blocked
access honestly and retains unfinished work. Captured transcripts are reused.
GitHub can disable public-repository schedules after 60 days without repository
activity; a stale check-in in Tracking exposes a stopped or delayed schedule.

Public runner minutes do not include external API costs, paid transcript
services, larger runners or excess storage. The current capture preference is
free access with gaps and slower processing accepted.

See [engine and processing notes](docs/ENGINE_V2.md) for implementation details,
validation history and current limitations.
