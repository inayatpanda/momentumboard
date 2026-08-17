// THE STREET (owner request, 2026-08-17): "i think the summary of youtube video
// input deserve a section of their own, and there should be a system where the
// youtube suggestions are also evaluated by our engine and highlighted - all in
// a new page/tab altogether. i dont like the intel page which is overwhelmed by
// news desk."
//
// Same local-first harness as Intel's tests: every network fetcher rejects,
// every case paints from a seeded Dexie slice. Two slices feed this page — the
// wire it owns, and the BOARD slice Today already fetched, which is where the
// engine's stance comes from. The second one is the point of the page, so the
// tests spend most of their time on the pairing.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { EnginePrediction, StreetVideo, StreetWire } from '../lib/api'
import type { BoardSlice, ChannelPick } from '../lib/apiViews'
import { getSocialPulse, getStreetWire } from '../lib/api'
import { getBoardSlice } from '../lib/apiViews'
import Street2 from './Street2'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getStreetWire: vi.fn(notMocked), getSocialPulse: vi.fn(notMocked) }
})
vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return { ...actual, getBoardSlice: vi.fn(() => Promise.reject(new Error('not mocked in this test'))) }
})

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () => Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

const mkRow = (o: Partial<EnginePrediction> = {}): EnginePrediction => ({
  id: 'r1',
  sym: 'NVDA',
  name: 'NVIDIA',
  side: 'long',
  composite: 62,
  probability: 0.62,
  provisional: false,
  grade: 'A',
  expectedMovePct: 4.3,
  entry: 128.4,
  stop: 121.1,
  target: 141,
  capacityPct: 100,
  smallCap: false,
  earningsRisk: false,
  stage: 'trending',
  note: 'test note',
  riskRung: 3,
  riskPct: 1.25,
  instrument: null,
  paperOnly: false,
  factors: emptyFactors(),
  ...o,
})

const seedBoard = (board: EnginePrediction[]) =>
  writeSlice<BoardSlice>('board', {
    board: { date: '2026-08-14', generatedAt: Date.now(), regime: 'green', board },
    intradayFlags: null,
    eventRadar: null,
    runStatus: null,
    riskState: null,
    referenceBase: null,
    yesterday: null,
  })

const mkPick = (o: Partial<ChannelPick> = {}): ChannelPick => ({
  sym: 'NVDA',
  mentions7d: 4,
  mentionsPrior7d: 2,
  channels: 3,
  channelNames: ['Josh', 'Gareth', 'Nash'],
  bulls: 3,
  bears: 1,
  net: 2,
  crowded: false,
  shifted: false,
  ...o,
})

const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - h * 3600

const mkVideo = (o: Partial<StreetVideo> = {}): StreetVideo => ({
  url: 'https://youtu.be/v1',
  title: 'Why NVDA still runs',
  channel: 'Josh',
  at: hoursAgo(3),
  tickers: [{ sym: 'NVDA', stance: 'bull' }],
  themes: ['ai-capex'],
  ...o,
})

const seedWire = (o: Partial<StreetWire> = {}) => writeSlice<StreetWire>('street:wire', { videos: [], reads: [], consensus: [], at: hoursAgo(0), ...o })

const withRouter = (path = '/app/more/street') =>
  render(
    <Router base="/app" hook={memoryLocation({ path }).hook}>
      <Switch>
        <Route path="/stock/:sym">{(params: { sym: string }) => <div>Landed on {params.sym}</div>}</Route>
        <Route path="/more/street">
          <Street2 />
        </Route>
      </Switch>
    </Router>,
  )

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.quotes.clear()])
  vi.clearAllMocks()
})

describe('Street2', () => {
  it('has a heading "The street"', () => {
    withRouter()
    expect(screen.getByRole('heading', { level: 1, name: /the street/i })).toBeInTheDocument()
  })

  // THE ONE EXCEPTION to the honest-absent rule: a section may render nothing,
  // but a whole PAGE that renders nothing tells the reader it is broken.
  it('says so in one line when the wire has resolved and carries nothing at all', async () => {
    await seedWire()
    withRouter()
    expect(await screen.findByText(/the wire fills as videos land/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /the wire/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /deep reads/i })).not.toBeInTheDocument()
  })

  it('never claims an empty wire before the slice has resolved', () => {
    withRouter()
    expect(screen.queryByText(/the wire fills as videos land/i)).not.toBeInTheDocument()
  })

  // ONE REFRESH, THREE SLICES: the picks read the board, the wire is this
  // page's own, and the pulse came over from Intel with its key intact.
  it('the refresh affordance re-fetches the wire, the board and the pulse', async () => {
    withRouter()
    await waitFor(() => expect(getStreetWire).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    await waitFor(() => expect(getStreetWire).toHaveBeenCalledTimes(2))
    expect(getBoardSlice).toHaveBeenCalledTimes(2)
    expect(getSocialPulse).toHaveBeenCalledTimes(2)
  })

  describe('the picks board', () => {
    it('renders EVERY consensus name — the home screen’s eight-name cap is not this page’s', async () => {
      await seedWire({ consensus: Array.from({ length: 12 }, (_, i) => mkPick({ sym: `S${i}` })) })
      withRouter()
      const picks = (await screen.findByRole('region', { name: /channels’ picks/i })) as HTMLElement
      expect(picks.querySelectorAll('.cp-row')).toHaveLength(12)
    })

    it('drops a name nobody took a side on — a neutral mention is not a pick', async () => {
      await seedWire({ consensus: [mkPick({ sym: 'NVDA' }), mkPick({ sym: 'SAIDOUTLOUD', bulls: 0, bears: 0, net: 0 })] })
      withRouter()
      await screen.findByRole('link', { name: 'NVDA' })
      expect(screen.queryByText('SAIDOUTLOUD')).not.toBeInTheDocument()
    })

    it('names the channels behind each pick', async () => {
      await seedWire({ consensus: [mkPick({ channels: 5, channelNames: ['Josh', 'Gareth', 'Nash'] })] })
      withRouter()
      expect(await screen.findByText(/from Josh, Gareth, Nash \+ 2 more/)).toBeInTheDocument()
    })

    it('chips a name whose stance flipped against the prior week', async () => {
      await seedWire({ consensus: [mkPick({ shifted: true })] })
      withRouter()
      expect(await screen.findByText('stance flipped this week')).toHaveClass('pill', 'cp-shifted')
    })

    // THE POINT OF THE PAGE: the engine's own answer, read off the board slice
    // that Today already fetched — never refetched, never invented.
    it('pairs each pick with the engine’s stance, read off the board slice', async () => {
      await seedBoard([mkRow({ sym: 'NVDA', side: 'long', grade: 'A' }), mkRow({ id: 'r2', sym: 'AMD', watchOnly: true, horizon: 'week' })])
      await seedWire({ consensus: [mkPick({ sym: 'NVDA' }), mkPick({ sym: 'AMD' }), mkPick({ sym: 'GME' })] })
      withRouter()
      await screen.findByLabelText('Grade A')
      expect(screen.getByText('long')).toHaveClass('pill', 'long')
      expect(screen.getByText('watch')).toBeInTheDocument()
      expect(screen.getByText('no view')).toHaveClass('cp-noview')
      // an unsized row NEVER wears a letter (CX-13) — one grade on the page
      expect(screen.getAllByLabelText(/^Grade /)).toHaveLength(1)
      // REUSED, NEVER REFETCHED: a board slice Today filled minutes ago is
      // still fresh, so opening this page costs no request for it
      expect(getBoardSlice).not.toHaveBeenCalled()
    })

    it('renders nothing at all when the wire carries no picks but does carry videos', async () => {
      await seedWire({ videos: [mkVideo()] })
      withRouter()
      await screen.findByRole('heading', { name: /the wire/i })
      expect(screen.queryByRole('region', { name: /channels’ picks/i })).not.toBeInTheDocument()
    })
  })

  describe('the wire', () => {
    it('renders one card a video: channel, stamp, and the title as an external link', async () => {
      await seedWire({ videos: [mkVideo({ at: hoursAgo(2) })] })
      withRouter()
      const card = (await screen.findByText('Why NVDA still runs')).closest('.stt-video') as HTMLElement
      expect(within(card).getByText('Josh')).toBeInTheDocument()
      expect(within(card).getByText('2h ago')).toBeInTheDocument()
      const link = within(card).getByRole('link', { name: 'Why NVDA still runs' })
      expect(link).toHaveAttribute('href', 'https://youtu.be/v1')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    })

    it('colours a ticker chip by the stance the channel took, and links it to the name', async () => {
      await seedWire({
        videos: [mkVideo({ tickers: [{ sym: 'NVDA', stance: 'bull' }, { sym: 'COIN', stance: 'bear' }, { sym: 'SPY', stance: 'neutral' }] })],
      })
      withRouter()
      const bull = await screen.findByRole('link', { name: 'NVDA' })
      expect(bull).toHaveClass('pill', 'long')
      expect(bull).toHaveAttribute('href', '/app/stock/NVDA')
      expect(screen.getByRole('link', { name: 'COIN' })).toHaveClass('pill', 'short')
      // neutral is neither direction, and must not borrow a direction's colour
      const flat = screen.getByRole('link', { name: 'SPY' })
      expect(flat).toHaveClass('pill')
      expect(flat).not.toHaveClass('long')
      expect(flat).not.toHaveClass('short')
    })

    it('prints the themes the video was about', async () => {
      await seedWire({ videos: [mkVideo({ themes: ['ai-capex', 'rate-cuts'] })] })
      withRouter()
      expect(await screen.findByText('ai-capex')).toBeInTheDocument()
      expect(screen.getByText('rate-cuts')).toBeInTheDocument()
    })

    // HOW THE FACTS WERE OBTAINED. A model that watched the video saw levels
    // drawn on charts; one that read a transcript did not — and a row from
    // before the field existed says nothing rather than guessing.
    it('says whether the video was watched or read, and says nothing when it cannot know', async () => {
      await seedWire({
        videos: [
          mkVideo({ url: 'https://youtu.be/w', title: 'Watched one', via: 'gemini-video' }),
          mkVideo({ url: 'https://youtu.be/r', title: 'Read one', via: 'supadata' }),
          mkVideo({ url: 'https://youtu.be/n', title: 'Unknown one' }),
        ],
      })
      withRouter()
      await screen.findByText('Watched one')
      expect(screen.getByText('watched')).toBeInTheDocument()
      expect(screen.getByText('read')).toBeInTheDocument()
      const unknown = screen.getByText('Unknown one').closest('.stt-video') as HTMLElement
      expect(within(unknown).queryByText(/watched|read/)).not.toBeInTheDocument()
    })

    it('shows twelve cards, then the rest behind Show more', async () => {
      await seedWire({ videos: Array.from({ length: 20 }, (_, i) => mkVideo({ url: `https://youtu.be/v${i}`, title: `Video ${i}` })) })
      withRouter()
      await screen.findByText('Video 0')
      expect(screen.getAllByText(/^Video \d+$/)).toHaveLength(12)
      fireEvent.click(screen.getByRole('button', { name: /show more \(8\)/i }))
      expect(screen.getAllByText(/^Video \d+$/)).toHaveLength(20)
    })
  })

  describe('the deep reads', () => {
    it('renders the narrative read as prose, with its channel, title link and stamp', async () => {
      await seedWire({
        reads: [{ url: 'https://youtu.be/deep', title: 'The whole macro picture', channel: 'Nash', analysis: 'Rates are the only story that matters.', at: hoursAgo(5) }],
      })
      withRouter()
      const read = (await screen.findByText('Rates are the only story that matters.')).closest('.stt-read') as HTMLElement
      expect(within(read).getByText('Nash')).toBeInTheDocument()
      expect(within(read).getByRole('link', { name: 'The whole macro picture' })).toHaveAttribute('href', 'https://youtu.be/deep')
      expect(within(read).getByText('5h ago')).toBeInTheDocument()
    })

    it('renders nothing at all when no deep read exists', async () => {
      await seedWire({ videos: [mkVideo()] })
      withRouter()
      await screen.findByRole('heading', { name: /the wire/i })
      expect(screen.queryByRole('heading', { name: /deep reads/i })).not.toBeInTheDocument()
    })
  })

  // THE PULSE CAME OVER FROM INTEL, key intact — a reader who had Intel cached
  // this morning keeps that data here with no round trip.
  it('renders the social pulse off the very slice Intel used to fill', async () => {
    await writeSlice('intel:social', {
      discoveries: [],
      alsoLoud: ['TSLA'],
      pulse: [{ sym: 'GME', name: 'GameStop', redditRank: 1, redditMentions: 90, surging: true, surgeMultiple: 3.2, stocktwits: false, channelNet: null, sources: 1, onWatchlist: false }],
      at: Date.now(),
    })
    withRouter()
    expect(await screen.findByText('Social pulse')).toBeInTheDocument()
    expect(screen.getByText('GameStop')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /GME/ })).toHaveAttribute('href', '/app/stock/GME')
  })
})
