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

All workflows use standard `ubuntu-latest` runners. These runner minutes are
free for this public repository under GitHub's current billing rules. Workflow
jobs are restricted to the original repository's `main` branch; forks must
configure their own services and adjust those guards. Production credentials
are stored as repository secrets, never in the source.

YouTube discovery and best-effort caption retrieval run in the cloud. A local
collector can fill capture gaps when its host is awake. Video access is not
guaranteed: unavailable captions, restricted videos and provider limits remain
visible as incomplete work. Captured transcripts are retained and reused.

Public runner minutes do not include external API costs, paid transcript
services, larger runners or excess storage. The current capture preference is
free access with gaps and slower processing accepted.

See [engine and processing notes](docs/ENGINE_V2.md) for implementation details,
validation history and current limitations.
