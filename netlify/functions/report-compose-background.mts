import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { callLlm } from './lib/llm'
import { composePrompt, parseComposed, buildNewspaperHtml } from './lib/newspaper'
import { cachedQuote, cachedCandles } from './lib/marketCache'
import { regimeFromCandles } from '../../shared/setups'
import type { AppConfig } from '../../shared/config'

// The guaranteed morning paper: gathers everything the system already knows,
// has the LLM write the journalism, builds the newspaper in code, publishes
// through the same /report pipe (Telegram ping + archive + picks capture).
// Runs as a background function (15-min budget); kicked by report-kick on
// weekday mornings or manually by the admin.

const SITE = process.env.URL ?? 'https://momentumboard-inayat.netlify.app'

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return new Response('admin-only', { status: 401 })

  const nowSec = Math.floor(Date.now() / 1000)
  const dateISO = new Date(nowSec * 1000).toISOString().slice(0, 10)
  const dateLabel = new Date(nowSec * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' })

  try {
    // ---- gather: every ingredient comes from our own libs/stores ----
    const cfg = (await blobAppStore.read<AppConfig>('config')) ?? { watchlist: [], rules: [], ytChannels: [], capital: 5000, notes: [] }
    const symbols = cfg.watchlist.map(w => w.symbol).slice(0, 20)

    const [spy, qqq] = await Promise.all([cachedCandles('SPY'), cachedCandles('QQQ')])
    const regime = spy && qqq ? regimeFromCandles(spy, qqq) : 'unknown'

    const quotes = (
      await Promise.all(
        symbols.map(async s => {
          const q = await cachedQuote(s, process.env.FINNHUB_API_KEY ?? '').catch(() => null)
          return q ? `${s} ${q.price} (${q.changePct.toFixed(1)}%)` : null
        }),
      )
    ).filter(Boolean)

    const grab = async <T,>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null)

    const [portfolio, sectors, consensus, social, insiders, econ, dossiers, picksHistory, pickStats] = await Promise.all([
      grab(() => blobAppStore.read('portfolio')),
      grab(async () => {
        const { getCached } = await import('./lib/cache')
        return getCached('sector-rotation')
      }),
      grab(async () => {
        const { computeConsensus } = await import('./lib/videoTrends')
        const extracts = ((await blobAppStore.read<unknown[]>('video-extracts')) ?? []) as Parameters<typeof computeConsensus>[0]
        return computeConsensus(extracts, nowSec)
      }),
      grab(async () => {
        const { fetchRedditTrends, fetchStocktwitsTrending, combineSocialPulse } = await import('./lib/social')
        const [r, st] = await Promise.all([fetchRedditTrends(), fetchStocktwitsTrending()])
        return combineSocialPulse(r, st, [], symbols).slice(0, 12)
      }),
      grab(async () => {
        const { fetchInsiderBuys } = await import('./lib/insiders')
        return symbols.length ? fetchInsiderBuys(symbols, process.env.FINNHUB_API_KEY ?? '') : []
      }),
      grab(async () => {
        const { parseEconFeed } = await import('./lib/econCalendar')
        const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
        return parseEconFeed((await res.json()) as never).slice(0, 8)
      }),
      grab(async () => ((await blobAppStore.read<unknown[]>('event-dossiers')) ?? []).slice(-2)),
      grab(async () => {
        const { computePersistence } = await import('./lib/picks')
        const history = ((await blobAppStore.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof computePersistence>[0]
        return { persistence: computePersistence(history).slice(0, 8), reports: history.length }
      }),
      grab(async () => {
        const { getCached } = await import('./lib/cache')
        return getCached('pick-stats')
      }),
    ])

    const news = await grab(async () => {
      const { fetchNews } = await import('./lib/news')
      return (await fetchNews(symbols, process.env.FINNHUB_API_KEY ?? '', nowSec)).slice(0, 10).map(n => n.title)
    })

    const data = JSON.stringify(
      {
        capital: cfg.capital,
        regime,
        watchlistQuotes: quotes,
        portfolio,
        sectorRotation: sectors,
        channelConsensus: consensus,
        socialPulse: social,
        insiderBuying: insiders,
        econCalendarThisWeek: econ,
        recentEventAssessments: dossiers,
        pickPersistence: picksHistory,
        ownScorecard: pickStats,
        userNotes: cfg.notes ?? [],
        headlines: news,
      },
      null,
      1,
    ).slice(0, 28_000)

    // ---- compose: the LLM writes the journalism as strict JSON ----
    const { text, provider } = await callLlm(composePrompt(data, dateLabel), { maxTokens: 3500 })
    let composed = parseComposed(text)
    if (!composed) {
      const retry = await callLlm(`${composePrompt(data, dateLabel)}\n\nIMPORTANT: your previous answer was not valid JSON. Return ONLY the JSON object.`, { maxTokens: 3500 })
      composed = parseComposed(retry.text)
    }
    if (!composed) return new Response('compose-unparseable', { status: 502 })

    // ---- publish through the same pipe the routine uses ----
    const html = buildNewspaperHtml(composed, dateLabel)
    const putHtml = await fetch(`${SITE}/report`, {
      method: 'PUT',
      headers: { 'x-report-token': process.env.REPORT_TOKEN ?? '', 'content-type': 'text/html' },
      body: html,
    })
    const picksBody = {
      date: dateISO,
      regime: composed.regime,
      macro: { fedStance: composed.fedStance, notes: composed.macroNotes },
      picks: composed.ideas.map(i => ({ ticker: i.ticker, side: i.side, playbook: i.playbook, conviction: i.conviction, strength: i.strength, reasons: i.reasons ?? [i.caseText] })),
    }
    const putPicks = composed.ideas.length
      ? await fetch(`${SITE}/report`, {
          method: 'PUT',
          headers: { 'x-report-token': process.env.REPORT_TOKEN ?? '', 'content-type': 'application/json' },
          body: JSON.stringify(picksBody),
        })
      : null

    const runlog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
    runlog.push({ at: nowSec, kind: 'report-compose', provider, htmlOk: putHtml.ok, picksOk: putPicks?.ok ?? 'none', ideas: composed.ideas.length })
    await blobAppStore.write('runlog', runlog.slice(-200))

    return new Response('ok')
  } catch (e) {
    return new Response(String(e), { status: 502 })
  }
}
