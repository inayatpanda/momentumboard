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

const SITE = process.env.URL ?? 'https://streetsignal.netlify.app'

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

    // watchlist + benchmarks + the liquid sector ETFs, so ideas can carry REAL levels
    const priceSymbols = [...new Set([...symbols, 'SPY', 'QQQ', 'BTC-USD', 'ETH-USD', 'XLK', 'XLY', 'XLC', 'XLE', 'XLF', 'XLV'])]
    const quotes = (
      await Promise.all(
        priceSymbols.map(async s => {
          const q = await cachedQuote(s, process.env.FINNHUB_API_KEY ?? '').catch(() => null)
          return q ? `${s} ${q.price} (${q.changePct.toFixed(1)}%)` : null
        }),
      )
    ).filter(Boolean)

    const grab = async <T,>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null)

    const [portfolio, sectors, consensus, social, insiders, econ, dossiers, picksHistory, pickStats] = await Promise.all([
      grab(() => blobAppStore.read('portfolio')),
      grab(async () => {
        // computed fresh so the paper's charts and tables never depend on cache warmth
        const { SECTORS, computeSectorRows } = await import('./lib/sectors')
        const pairs = await Promise.all(SECTORS.map(async s => [s.sym as string, await cachedCandles(s.sym)] as const))
        const bySym = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[1][1]>] => p[1] !== null))
        return spy ? computeSectorRows(bySym, spy) : null
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

    // ---- deterministic paper extras: rotation tables, social board, charts ----
    const { SECTOR_MEMBERS, SECTORS, returnOver } = await import('./lib/sectors')
    const topSectors = (sectors ?? []).filter(s => s.rs21 != null).slice(0, 2)
    const rotationTables = await Promise.all(
      topSectors.map(async s => ({
        sector: SECTORS.find(x => x.sym === s.sym)?.name ?? s.sym,
        etf: s.sym,
        rows: await Promise.all(
          (SECTOR_MEMBERS[s.sym] ?? []).map(async sym => {
            const [q, candles] = await Promise.all([
              cachedQuote(sym, process.env.FINNHUB_API_KEY ?? '').catch(() => null),
              cachedCandles(sym).catch(() => null),
            ])
            return {
              sym,
              price: q?.price ?? null,
              wkPct: candles ? returnOver(candles, 5) : null,
              closes: candles?.slice(-63).map(c => c.c),
            }
          }),
        ),
      })),
    )
    // movement capacity: can each candidate ACTUALLY travel 10% in ~2 weeks?
    const { swingCapacity } = await import('../../shared/indicators')
    const candidateSyms = [...new Set([
      ...rotationTables.flatMap(t => t.rows.map(r => r.sym)),
      ...(social ?? []).slice(0, 6).map(s2 => s2.sym),
      ...symbols,
    ])].slice(0, 24)
    const moveCapacity = (
      await Promise.all(
        candidateSyms.map(async sym => {
          const candles = await cachedCandles(sym).catch(() => null)
          const cap = candles ? swingCapacity(candles.map(c => c.c)) : null
          return cap != null ? { sym, typical10dMovePct: cap, capable10pct: cap >= 8 } : null
        }),
      )
    ).filter(Boolean)

    const { getCached } = await import('./lib/cache')
    const socialBoard = await Promise.all(
      (social ?? []).slice(0, 10).map(async s => ({
        sym: s.sym,
        redditRank: s.redditRank,
        redditMentions: s.redditMentions,
        surgeMultiple: s.surgeMultiple,
        sources: s.sources,
        capUsdM: ((await getCached<{ capUsdM: number | null }>(`cap:${s.sym}`)) ?? {}).capUsdM ?? null,
      })),
    )
    const extras = {
      rotationTables,
      socialBoard,
      calendar: (econ ?? []).filter(e => e.at > nowSec && e.at < nowSec + 5 * 86_400).slice(0, 6),
      spyCloses: spy?.slice(-63).map(c => c.c),
      sectorBars: (sectors ?? []).map(s => ({ name: SECTORS.find(x => x.sym === s.sym)?.name ?? s.sym, rs21: s.rs21 })),
    }

    const data = JSON.stringify(
      {
        capital: cfg.capital,
        regime,
        watchlistQuotes: quotes,
        portfolio,
        sectorRotation: sectors,
        moveCapacity,
        rotationLeaders: rotationTables.map(t => ({ sector: t.sector, etf: t.etf, rows: t.rows.map(r => ({ sym: r.sym, price: r.price, wkPct: r.wkPct == null ? null : Math.round(r.wkPct * 10) / 10 })) })),
        channelConsensus: consensus,
        socialPulse: social,
        insiderBuying: insiders,
        econCalendarThisWeek: econ,
        recentEventAssessments: dossiers,
        pickPersistence: picksHistory,
        ownScorecard: pickStats,
        previousEditions: await blobAppStore.read('composed-history'),
        userNotes: cfg.notes ?? [],
        headlines: news,
      },
      null,
      1,
    ).slice(0, 28_000)

    console.log('COMPOSE: gathered ok, data bytes', data.length)
    // ---- compose: six small sections in parallel (Groq-sized), per-section
    // Gemini retry, single-shot Gemini as plan C. Small outputs rarely truncate.
    const { SECTIONS, sectionPrompt, extractJson, mergeSections } = await import('./lib/newspaper')
    const writeSection = async (spec: (typeof SECTIONS)[0]) => {
      try {
        const first = await callLlm(sectionPrompt(spec, data, dateLabel), { maxTokens: 1600 })
        const parsed = extractJson<Record<string, unknown>>(first.text)
        if (parsed) return { parsed, provider: first.provider }
      } catch { /* fall through to gemini retry */ }
      try {
        const retry = await callLlm(`${sectionPrompt(spec, data, dateLabel)}\nIMPORTANT: return ONLY valid JSON.`, { maxTokens: 1600, LLM_PROVIDER: 'gemini' })
        return { parsed: extractJson<Record<string, unknown>>(retry.text), provider: retry.provider }
      } catch {
        return { parsed: null, provider: 'none' }
      }
    }
    const sectionResults = await Promise.all(SECTIONS.map(writeSection))
    let provider = sectionResults.map(r => r.provider).join(',')
    let composed = mergeSections(sectionResults.map(r => r.parsed))
    console.log('COMPOSE: sections', sectionResults.map((r, i) => `${SECTIONS[i].key}:${r.parsed ? r.provider : 'FAIL'}`).join(' '))
    if (!composed) {
      // plan C: the single-shot big compose on gemini
      const single = await callLlm(composePrompt(data, dateLabel), { maxTokens: 8000, LLM_PROVIDER: 'gemini' })
      provider = `single:${single.provider}`
      composed = parseComposed(single.text)
    }
    console.log('COMPOSE: via', provider, '| parsed:', !!composed)
    if (!composed) { console.error('COMPOSE: unparseable after all fallbacks'); return new Response('compose-unparseable', { status: 502 }) }
    if (!(cfg.notes ?? []).length) delete composed.readersNotes // no phantom reader feedback

    // ---- publish through the same pipe the routine uses ----
    const html = buildNewspaperHtml(composed, dateLabel, extras)
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

    console.log('COMPOSE: putHtml', putHtml.status, 'putPicks', putPicks?.status)
    // continuity memory: tomorrow's edition reads what today's said, so it builds instead of repeating
    const historyEntry = {
      date: dateISO,
      headline: composed.headline,
      standfirst: composed.standfirst,
      regime: composed.regime,
      ideas: composed.ideas.map(i => ({ ticker: i.ticker, side: i.side, strength: i.strength })),
      rotationGist: composed.rotation.slice(0, 300),
      smallCapGist: (composed.smallCap ?? '').slice(0, 200),
    }
    const composedHistory = ((await blobAppStore.read<{ date: string }[]>('composed-history')) ?? []).filter(h => h.date !== dateISO)
    composedHistory.push(historyEntry)
    await blobAppStore.write('composed-history', composedHistory.slice(-4))

    const runlog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
    runlog.push({ at: nowSec, kind: 'report-compose', provider, htmlOk: putHtml.ok, picksOk: putPicks?.ok ?? 'none', ideas: composed.ideas.length })
    await blobAppStore.write('runlog', runlog.slice(-200))

    return new Response('ok')
  } catch (e) {
    console.error('COMPOSE-FAILED:', e)
    return new Response(String(e), { status: 502 })
  }
}
