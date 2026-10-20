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

`youtube-native-capture` uses Google's supported YouTube URL input, avoiding the
blocked download from a GitHub IP. It produces AI transcription and creator
claims in one request. It is configured for 08:17–23:17 UTC every three hours,
with at most two new attempts per day, a 20-minute input limit and no automatic
API retries. Quota errors leave work pending. This is a separate path from
independently downloaded captions and Whisper speech recognition.
Both cloud collectors restrict candidates to the followed-channel list. Stable
channel IDs take precedence over names. Before spending a native read, public
metadata is checked for live/upcoming broadcasts or incomplete source metadata.
Those checks are best effort when YouTube blocks metadata access. Longer videos
receive a limited read, not a claimed full transcription.

New reads **fail closed** unless `YOUTUBE_FREE_TIER_CONFIRMED=true` is configured
as a repository variable and `GEMINI_YOUTUBE_FREE_API_KEY` is present as a
repository secret. Use a Google project with **billing disabled** and a separate
key for StreetSignal. A shared project also shares its free allowance;
a model advertising a free tier does not make requests on a paid project free.
The workflow never substitutes the app's ordinary Gemini key. Manual runs
default to `cached_only=true`, which publishes saved drafts without receiving
the Google key or calling the transcription API.
After a successful free-key test, set `YOUTUBE_NATIVE_SCHEDULE_ENABLED=true`
to enable unattended runs. Its two daily attempts are independent from legacy
Gemini analysis budgets, so failures in that older path cannot starve this one.
The manual `youtube-native-check` diagnostic allows one additional bounded
verification per day on the free key.

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
  conclusion after minute 10. The bounded limit therefore covers 20 minutes;
  longer recordings remain partial reads and can omit later conclusions.

See [engine and processing notes](docs/ENGINE_V2.md) for implementation details,
validation history and current limitations.
