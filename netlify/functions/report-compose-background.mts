import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { callLlm } from './lib/llm'
import { composePrompt, parseComposed, buildNewspaperHtml, constrainIdeasToBoard, validateNominations, mergeNominations, type StoredNomination } from './lib/newspaper'
import { cachedQuote, cachedCandles, cachedCompanyName } from './lib/marketCache'
import { regimeFromCandles } from '../../shared/setups'
import type { AppConfig } from '../../shared/config'

// The guaranteed morning paper: gathers everything the system already knows,
// has the LLM write the journalism, builds the newspaper in code, publishes
// through the same /report pipe (Telegram ping + archive + picks capture).
// Runs as a background function (15-min budget); kicked by report-kick on
// weekday mornings or manually by the admin.

const SITE = process.env.URL ?? 'https://thestreetsignal.rqai.co.uk'

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

    // NOTE: the reader's journal ('portfolio' blob) and T212 book deliberately
    // do NOT feed the paper any more — the report now goes to other people,
    // and the publisher's personal positions are nobody's business (2026-07-15).
    // Their in-app home is the Positions screen and the Desk holdings pane.
    const [sectors, consensus, social, insiders, econ, dossiers, picksHistory, pickStats] = await Promise.all([
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

    const channelVideos = await grab(async () => {
      const { fetchVideos } = await import('./lib/youtube')
      const { withDefaults } = await import('../../shared/channels')
      return (await fetchVideos(withDefaults(cfg.ytChannels), nowSec)).slice(0, 10).map(v => ({ channel: v.channel, title: v.title }))
    })

    const mediaHeadlines = await grab(async () => {
      // hard-paywalled outlets still publish headline RSS — titles are real
      // signal. Feed list (incl. Barron's + Bloomberg) shared with the engine.
      const { fetchMediaTitles } = await import('./lib/engine')
      return (await fetchMediaTitles()).slice(0, 18)
    })

    // the engine's scored board: fresh = composed today (London). Stale or
    // missing → the paper still publishes, in legacy qualitative mode.
    const engineBoard = await grab(async () => {
      const b = await blobAppStore.read<{ date: string; board: import('../../shared/engine/types').Prediction[] }>('engine-board')
      if (!b || b.date !== dateISO || !Array.isArray(b.board)) return null
      return b.board.slice(0, 16).map(p => ({
        id: p.id,
        sym: p.sym,
        side: p.side,
        grade: p.grade,
        probability: p.probability,
        provisional: p.provisional,
        composite: p.composite,
        entry: p.entry,
        stop: p.stop,
        target: p.target,
        expectedMovePct: p.expectedMovePct,
        capacityPct: p.capacityPct,
        stage: p.stage,
        note: p.note,
        smallCap: p.smallCap,
        earningsRisk: p.earningsRisk,
        riskPct: p.riskPct,
        instrument: p.instrument,
        paperOnly: p.paperOnly,
        watchOnly: p.watchOnly,
        setup: p.setup,
        evidence: p.evidence?.detail,
        factorDetails: Object.fromEntries(Object.entries(p.factors).filter(([, f]) => f.score != null).map(([k, f]) => [k, `${f.score} — ${f.detail}`])),
      }))
    })
    const engineFresh = !!engineBoard?.length

    // event radar: the same predict run writes this alongside the board — dated
    // earnings binaries the engine tracks, with the shape going in. Fresh = today.
    // Never a call; the paper prints it as a forward-looking heads-up table.
    const eventRadar = await grab(async () => {
      const r = await blobAppStore.read<{ date: string; entries: { sym: string; name?: string | null; date: string; daysToPrint: number; stage: string | null; rs21: number | null; note: string | null }[] }>('event-radar')
      if (!r || r.date !== dateISO || !Array.isArray(r.entries)) return null
      return r.entries.slice(0, 12).map(e => ({ sym: e.sym, name: e.name ?? null, date: e.date, daysToPrint: e.daysToPrint, stage: e.stage, rs21: e.rs21, note: e.note }))
    })

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
    // for each candidate: can it MOVE (capacity) AND where is it in its move (stage)?
    const { swingCapacity } = await import('../../shared/indicators')
    const { technicalStage } = await import('../../shared/technicals')
    const candidateSyms = [...new Set([
      ...rotationTables.flatMap(t => t.rows.map(r => r.sym)),
      ...(social ?? []).slice(0, 6).map(s2 => s2.sym),
      ...symbols,
    ])].slice(0, 24)
    const candidateReads = (
      await Promise.all(
        candidateSyms.map(async sym => {
          const candles = await cachedCandles(sym).catch(() => null)
          if (!candles) return null
          const cap = swingCapacity(candles.map(c => c.c))
          const tech = technicalStage(sym, candles)
          if (cap == null && !tech) return null
          return {
            sym,
            typical10dMovePct: cap,
            capable10pct: cap != null && cap >= 8,
            stage: tech?.stage ?? null,
            entryQuality: tech?.entryQuality ?? null,
            rsi: tech?.rsi ?? null,
            pctFrom20d: tech?.pctFrom20d ?? null,
            rangePos: tech?.rangePos ?? null,
            rvol: tech?.rvol ?? null,
            volumeConfirmed: tech?.volumeConfirmed ?? false,
            setups: tech?.setups ?? [],
            read: tech?.note ?? null,
          }
        }),
      )
    ).filter(Boolean)

    // new-listings tape: fresh + imminent IPOs (fail-soft — a dead calendar just
    // drops the section, same contract as every other extra)
    const ipos = await (async () => {
      try {
        const { fetchIpoCalendar, upcomingListings, recentListings } = await import('./lib/ipoCalendar')
        const today = new Date(nowSec * 1000).toISOString().slice(0, 10)
        const from = new Date((nowSec - 90 * 86_400) * 1000).toISOString().slice(0, 10)
        const to = new Date((nowSec + 7 * 86_400) * 1000).toISOString().slice(0, 10)
        const rows = await fetchIpoCalendar(process.env.FINNHUB_API_KEY ?? '', from, to)
        const slim = (r: { sym: string; name: string; date: string; status: string }) => ({ sym: r.sym, name: r.name, date: r.date, status: r.status })
        return { upcoming: upcomingListings(rows, today).slice(0, 8).map(slim), recent: recentListings(rows, today).slice(0, 8).map(slim) }
      } catch {
        return undefined
      }
    })()

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
      ipos,
      eventRadar: eventRadar ?? undefined,
      calendar: (econ ?? []).filter(e => e.at > nowSec && e.at < nowSec + 5 * 86_400).slice(0, 6),
      spyCloses: spy?.slice(-63).map(c => c.c),
      sectorBars: (sectors ?? []).map(s => ({ name: SECTORS.find(x => x.sym === s.sym)?.name ?? s.sym, rs21: s.rs21 })),
      // the board typeset in code — grades and levels never depend on the LLM
      engineBoard: (engineBoard ?? []).map(b => ({
        sym: b.sym,
        name: undefined as string | undefined, // enriched below from the cap cache
        side: b.side,
        grade: b.grade,
        provisional: b.provisional,
        probability: b.probability,
        entry: b.entry,
        stop: b.stop,
        target: b.target,
        expectedMovePct: b.expectedMovePct,
        paperOnly: b.paperOnly,
        watchOnly: b.watchOnly,
        earningsRisk: b.earningsRisk,
        instrument: b.instrument,
      })),
    }

    // Budget-aware: whole low-priority keys drop first — never a mid-JSON cut
    // that silently deletes whatever serialized last (it was the headlines).
    const { buildDataJson } = await import('./lib/newspaper')
    const { json: data, dropped } = buildDataJson(
      {
        capital: cfg.capital,
        regime,
        engineBoard, // null = engine offline; ideas then fall back to candidateReads rules
        mediaHeadlines,
        headlines: news,
        econCalendarThisWeek: econ,
        watchlistQuotes: quotes,
        sectorRotation: sectors,
        channelConsensus: consensus,
        previousEditions: await blobAppStore.read('composed-history'),
        ownScorecard: pickStats,
        candidateReads,
        rotationLeaders: rotationTables.map(t => ({ sector: t.sector, etf: t.etf, rows: t.rows.map(r => ({ sym: r.sym, price: r.price, wkPct: r.wkPct == null ? null : Math.round(r.wkPct * 10) / 10 })) })),
        socialPulse: social,
        recentChannelVideos: channelVideos,
        insiderBuying: insiders,
        pickPersistence: picksHistory,
        userNotes: cfg.notes ?? [],
        recentEventAssessments: dossiers,
      },
      // drop order: least critical first — the engine board and headlines must
      // survive. pickPersistence + previousEditions are last: they are tiny and
      // they are the paper's memory — dropping them (as the old order did every
      // single day) is why editions re-announced the same story as breaking.
      ['recentEventAssessments', 'userNotes', 'insiderBuying', 'recentChannelVideos', 'socialPulse', 'rotationLeaders', 'candidateReads', 'ownScorecard', 'channelConsensus', 'sectorRotation', 'watchlistQuotes', 'pickPersistence', 'previousEditions'],
    )

    console.log('COMPOSE: gathered ok, data bytes', data.length, dropped.length ? `| dropped to fit: ${dropped.join(',')}` : '')
    // ---- compose: six small sections in parallel (Groq-sized), per-section
    // Gemini retry, single-shot Gemini as plan C. Small outputs rarely truncate.
    const { SECTIONS, sectionPrompt, extractJson, mergeSections } = await import('./lib/newspaper')
    const writeSection = async (spec: (typeof SECTIONS)[0], covered?: string[]) => {
      try {
        const first = await callLlm(sectionPrompt(spec, data, dateLabel, covered), { maxTokens: 1600 })
        const parsed = extractJson<Record<string, unknown>>(first.text)
        if (parsed) return { parsed, provider: first.provider }
      } catch { /* fall through to gemini retry */ }
      try {
        const retry = await callLlm(`${sectionPrompt(spec, data, dateLabel, covered)}\nIMPORTANT: return ONLY valid JSON.`, { maxTokens: 1600, LLM_PROVIDER: 'gemini' })
        return { parsed: extractJson<Record<string, unknown>>(retry.text), provider: retry.provider }
      } catch {
        return { parsed: null, provider: 'none' }
      }
    }
    // Two waves: the ideas desk writes first, then every section that could
    // re-pitch its names (signal/discovery/voice) writes knowing what is
    // already fully cased. Fully parallel writers CANNOT avoid duplicating
    // each other — the reader met the same pick in four sections.
    const WAVE1 = new Set(['lead', 'desk', 'ideas', 'rotation'])
    const wave1Specs = SECTIONS.filter(s => WAVE1.has(s.key))
    const wave2Specs = SECTIONS.filter(s => !WAVE1.has(s.key))
    const wave1Results = await Promise.all(wave1Specs.map(s => writeSection(s)))
    const ideasParsed = wave1Results[wave1Specs.findIndex(s => s.key === 'ideas')]?.parsed as { ideas?: { ticker?: unknown }[] } | null
    const covered = [...new Set((ideasParsed?.ideas ?? []).map(i => String(i.ticker ?? '').toUpperCase()).filter(Boolean))]
    const wave2Results = await Promise.all(wave2Specs.map(s => writeSection(s, covered)))
    const sectionResults = SECTIONS.map(spec => {
      const i1 = wave1Specs.indexOf(spec)
      return i1 >= 0 ? wave1Results[i1] : wave2Results[wave2Specs.indexOf(spec)]
    })
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

    if (engineFresh) {
      // the journalist narrates the board — numbers come from the engine, verbatim
      const constrained = constrainIdeasToBoard(composed.ideas, engineBoard!)
      composed.ideas = constrained.ideas
      if (constrained.rejected.length) console.log('COMPOSE: rejected off-board ideas:', constrained.rejected.join(', '))
      if (!composed.ideas.length) {
        // the LLM filed nothing usable — the desk sets the table from the board itself
        const { fallbackIdeasFromBoard } = await import('./lib/newspaper')
        composed.ideas = fallbackIdeasFromBoard(engineBoard!)
        console.log('COMPOSE: ideas fallback from board:', composed.ideas.map(i => i.ticker).join(', '))
      }
      if (constrained.overlays.length) {
        // overlays land in the ledger so the LLM's judgment gets graded too
        const preds = (await blobAppStore.read<import('../../shared/engine/types').Prediction[]>(`predictions:${dateISO}`)) ?? []
        for (const o of constrained.overlays) {
          const p = preds.find(x => x.id === o.predictionId)
          if (p) p.overlay = { flag: o.flag, reason: o.reason }
        }
        await blobAppStore.write(`predictions:${dateISO}`, preds)
        console.log('COMPOSE: overlays', constrained.overlays.map(o => `${o.predictionId}:${o.flag}`).join(' '))
      }
    } else {
      const day = new Date(nowSec * 1000).getUTCDay()
      composed.standfirst = day === 0 || day === 6
        ? `${composed.standfirst} — Weekend edition: markets closed, eyes on the week ahead.`
        : `${composed.standfirst} — Engine offline this morning; qualitative edition.`
    }

    // ---- AI roster nominations → feed the NEXT morning's predict run ----
    // The analyst may nominate tickers for the ENGINE'S ROSTER (its hunting
    // ground) — never its board. They persist here; because compose runs AFTER
    // predict in the daily chain, tomorrow's buildBoard consumes them as one more
    // candidate source, gated and priced like any other. Written even when empty
    // so the 7-day expiry always advances.
    const freshNoms = validateNominations(composed.nominations)
    const priorNoms = (await blobAppStore.read<StoredNomination[]>('ai-nominations')) ?? []
    await blobAppStore.write('ai-nominations', mergeNominations(priorNoms, freshNoms, dateISO, nowSec))
    console.log('COMPOSE: nominations', freshNoms.map(n => n.sym).join(',') || 'none')

    // ---- company names: never show the reader a bare ticker ----
    // Enrich the FINALISED ideas and the engine-board rows from the cap cache
    // (read-only, no network call), in parallel and fail-soft — a miss just omits
    // the name. LSE symbols like RR.L pass through the lookup unchanged.
    try {
      const nameSyms = [...new Set([...composed.ideas.map(i => i.ticker), ...extras.engineBoard.map(b => b.sym)])]
      const names = new Map(await Promise.all(nameSyms.map(async sym => [sym, await cachedCompanyName(sym, process.env.FINNHUB_API_KEY ?? '').catch(() => null)] as const)))
      for (const i of composed.ideas) { const n = names.get(i.ticker); if (n) i.name = n }
      for (const b of extras.engineBoard) { const n = names.get(b.sym); if (n) b.name = n }
      console.log('COMPOSE: named', [...names.entries()].filter(([, n]) => n).length, 'of', nameSyms.length)
    } catch { /* names are best-effort — the paper publishes without them */ }

    // ---- claims audit: gentle, headline-level only ----
    // The numbers are computed; the PROSE is editorial — and editorial drifts
    // (an "XLE fading" line once contradicted its own +3pp 5-day read). A cheap
    // second pass checks ONLY the headline/standfirst/lead against the sector
    // facts and tones down clear contradictions. Deliberately light-touch: keep
    // the voice, change nothing defensible, fail-soft to the original prose.
    try {
      const factLines = (sectors ?? [])
        .filter(s => s.rs21 != null)
        .map(s => `${s.sym}: 1mo RS ${s.rs21! >= 0 ? '+' : ''}${s.rs21}pp, 5d RS ${s.rs5 != null ? `${s.rs5 >= 0 ? '+' : ''}${s.rs5}pp` : 'n/a'}, trend ${s.trend}`)
      if (factLines.length) {
        const auditPrompt = `You are the sub-editor fact-checking a market newspaper's front page against the desk's own data. FACTS (relative strength vs SPY):\n${factLines.join('\n')}\nRegime: ${regime}.\n\nDRAFT:\nHEADLINE: ${composed.headline}\nSTANDFIRST: ${composed.standfirst}\nLEAD: ${composed.lead}\n\nRewrite ONLY what clearly contradicts the facts (e.g. calling a sector "fading" when its 5-day RS is positive and trend is "in"). Keep the voice, keep everything defensible, do not soften for style. Return ONLY JSON: {"headline":"...","standfirst":"...","lead":"..."} — fields you did not change must be returned verbatim.`
        const { text } = await callLlm(auditPrompt, { maxTokens: 900 })
        const m = text.match(/\{[\s\S]*\}/)
        if (m) {
          const audited = JSON.parse(m[0]) as { headline?: string; standfirst?: string; lead?: string }
          if (audited.headline && audited.standfirst && audited.lead) {
            const changed = audited.headline !== composed.headline || audited.standfirst !== composed.standfirst || audited.lead !== composed.lead
            composed.headline = audited.headline
            composed.standfirst = audited.standfirst
            composed.lead = audited.lead
            console.log('COMPOSE: claims audit', changed ? 'amended the front page' : 'passed unchanged')
          }
        }
      }
    } catch { /* audit is best-effort — the original prose stands */ }

    // ---- freshness pass: no sentence runs in two editions ----
    // The continuity data tells the writer what was already covered; this
    // catches what slips through anyway. Deterministic detector first (zero
    // LLM cost on clean days); one rewrite call only when yesterday's wording
    // actually recurs. Fail-soft: today's prose stands on any error.
    try {
      const hist = ((await blobAppStore.read<{ date: string }[]>('composed-history')) ?? []).filter(h => h.date !== dateISO)
      const prevDate = hist.at(-1)?.date
      const prior = prevDate ? await blobAppStore.read<{ html?: string }>(`report:${prevDate}`) : null
      const priorText = (prior?.html ?? '')
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
      if (priorText) {
        const { findVerbatimRepeats } = await import('./lib/newspaper')
        const proseFields: Record<string, string | undefined> = {
          lead: composed.lead, tape: composed.tape, shortDesk: composed.shortDesk,
          smallCap: composed.smallCap, rotation: composed.rotation, crypto: composed.crypto,
          channels: composed.channels, editorial: composed.editorial,
          signalWhy: composed.signalWhy, honestClose: composed.honestClose,
        }
        const repeats = findVerbatimRepeats(proseFields, priorText).slice(0, 10)
        if (repeats.length) {
          const byField = [...new Set(repeats.map(r => r.field))]
          const rewritePrompt = `You are the sub-editor of a daily market paper. These sentences in today's draft appeared VERBATIM in yesterday's edition. Rewrite each listed section so the recycled sentences are freshly worded — same facts, same numbers, and where it reads naturally acknowledge the continuity ("as flagged yesterday…", "for the third session…"). Change nothing else in the section.\n\nRECYCLED:\n${repeats.map(r => `[${r.field}] ${r.sentence}`).join('\n')}\n\nSECTIONS:\n${byField.map(f => `${f}: ${proseFields[f]}`).join('\n\n')}\n\nReturn ONLY JSON: {${byField.map(f => `"${f}":"..."`).join(',')}} — every listed field present, full replacement text for the whole section.`
          const { text } = await callLlm(rewritePrompt, { maxTokens: 1800 })
          const m = text.match(/\{[\s\S]*\}/)
          if (m) {
            const fresh = JSON.parse(m[0]) as Record<string, string>
            // audit L-3: a rewording must not INVENT or change a fact. Reject any
            // rewrite whose numeric tokens aren't all present in the original —
            // a changed price/level/percent silently corrupting the paper is far
            // worse than a repeated sentence surviving. Rejections are logged.
            const numsOf = (s: string) => new Set((s.match(/-?\d[\d,]*\.?\d*%?/g) ?? []).map(n => n.replace(/,/g, '')))
            let applied = 0
            const rejected: string[] = []
            for (const f of byField) {
              const next = fresh[f]
              const orig = proseFields[f] ?? ''
              const lenOk = typeof next === 'string' && next.length >= orig.length * 0.4 && next.length <= orig.length * 2 + 200
              const origNums = numsOf(orig)
              const numsOk = lenOk && [...numsOf(next)].every(n => origNums.has(n))
              if (numsOk) {
                ;(composed as unknown as Record<string, unknown>)[f] = next
                applied++
              } else {
                rejected.push(`${f}:${!lenOk ? 'length' : 'new-number'}`)
              }
            }
            console.log(`COMPOSE: freshness pass rewrote ${applied}/${byField.length} sections (${repeats.length} recycled)${rejected.length ? ` | REJECTED ${rejected.join(', ')} — original kept` : ''}`)
          }
        } else console.log('COMPOSE: freshness pass clean')
      }
    } catch { /* freshness is best-effort — today's prose stands */ }

    // ---- publish through the same pipe the routine uses ----
    const html = buildNewspaperHtml(composed, dateLabel, extras)
    // The print-edition PDF is now TYPESET from this structured payload (heat map,
    // SPY sparkline, ruled tables, per-idea strips) instead of re-parsed from the
    // HTML — the old regex path dropped every <svg> and, since the board became
    // stacked <div>s, the board too. We ship the composed report plus the same
    // deterministic extras the HTML uses; rotationTables shed their per-row closes
    // (dead weight for the print table). Envelope rides the text/html branch, so
    // report.mts unwraps { html, print } fail-soft and legacy raw-HTML still works.
    const print = {
      report: composed,
      engineBoard: extras.engineBoard,
      sectorBars: extras.sectorBars,
      spyCloses: extras.spyCloses,
      calendar: extras.calendar,
      ipos: extras.ipos,
      socialBoard: extras.socialBoard,
      eventRadar: extras.eventRadar,
      rotationTables: (extras.rotationTables ?? []).map(t => ({ sector: t.sector, etf: t.etf, rows: t.rows.map(r => ({ sym: r.sym, price: r.price, wkPct: r.wkPct })) })),
    }
    const putHtml = await fetch(`${SITE}/report`, {
      method: 'PUT',
      headers: { 'x-report-token': process.env.REPORT_TOKEN ?? '', 'content-type': 'text/html' },
      body: JSON.stringify({ html, print }),
    })
    const picksBody = {
      date: dateISO,
      regime: composed.regime,
      macro: { fedStance: composed.fedStance, notes: composed.macroNotes },
      picks: composed.ideas.map(i => ({ ticker: i.ticker, side: i.side, playbook: i.playbook, conviction: i.conviction, strength: i.strength, reasons: i.reasons ?? [i.caseText] })),
    }
    // Always record a pick day — even an empty one (audit M-8). The persistence
    // ledger's "last 7 reports" counts stored pick days, so a skipped no-signal
    // day used to vanish and inflate streaks; now every published edition has a
    // day, and `picks: []` cleanly means "no call was made".
    const putPicks = await fetch(`${SITE}/report`, {
      method: 'PUT',
      headers: { 'x-report-token': process.env.REPORT_TOKEN ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(picksBody),
    })

    console.log('COMPOSE: putHtml', putHtml.status, 'putPicks', putPicks?.status)

    // A failed publish must be LOUD. The old code logged the status then
    // returned 200 regardless, so a rejected PUT left the Action green with no
    // paper and no alert (audit H-2). HTML is the hard requirement: its failure
    // returns non-2xx (daily-run exits 1 → Action red) and skips the success
    // bookkeeping, and because report:<today> stays absent the watchdog re-kick
    // still fires. A picks-only failure means the paper IS live but its
    // scorecard source is missing — the owner is alerted; the edition stands.
    const alertOwner = async (msg: string) => {
      try {
        const { sendTelegram } = await import('./lib/telegram')
        const tok = process.env.TELEGRAM_BOT_TOKEN
        const chat = process.env.TELEGRAM_CHAT_ID
        if (tok && chat) await sendTelegram(tok, chat, msg)
      } catch (err) {
        console.error('COMPOSE: owner alert failed', err) // never let the alert mask the real failure
      }
    }

    if (!putHtml.ok) {
      const body = await putHtml.text().catch(() => '')
      const failLog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
      failLog.push({ at: nowSec, kind: 'report-compose', provider, htmlOk: false, status: putHtml.status, ideas: composed.ideas.length })
      await blobAppStore.write('runlog', failLog.slice(-200))
      await alertOwner(`🚨 StreetSignal ${dateISO}: report PUBLISH failed — HTTP ${putHtml.status}. No new edition today. ${body.slice(0, 120)}`)
      console.error('COMPOSE: publish FAILED', putHtml.status, body.slice(0, 200))
      return new Response(`publish-failed ${putHtml.status}`, { status: 502 })
    }
    if (putPicks && !putPicks.ok) {
      await alertOwner(`⚠️ StreetSignal ${dateISO}: paper published, but PICKS write failed — HTTP ${putPicks.status}. Today's scorecard/ledger source is missing.`)
      console.error('COMPOSE: picks publish failed', putPicks.status)
    }

    // continuity memory: tomorrow's edition reads what today's said, so it builds instead of repeating
    const historyEntry = {
      date: dateISO,
      headline: composed.headline,
      standfirst: composed.standfirst,
      regime: composed.regime,
      ideas: composed.ideas.map(i => ({ ticker: i.ticker, side: i.side, strength: i.strength })),
      rotationGist: composed.rotation.slice(0, 300),
      smallCapGist: (composed.smallCap ?? '').slice(0, 200),
      // what The Signal said — a call, or the gist of the no-signal reasoning —
      // so tomorrow's writer can vary it and count the streak instead of
      // re-deriving the same apology from scratch
      signalGist: composed.signal ? `called ${composed.signal.ticker} (${composed.signal.conviction})` : (composed.signalWhy ?? '').slice(0, 220),
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
    // H-2 gap: a fetch() throw (network/TLS/DNS) or any earlier error lands here
    // before putHtml exists, bypassing the in-try alert. Page the owner + log a
    // failure runlog so a dead compose is never silent (the Action goes red, but
    // the owner isn't watching CI). Best-effort — never mask the real failure.
    try {
      const failLog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
      failLog.push({ at: Math.floor(Date.now() / 1000), kind: 'report-compose', htmlOk: false, error: String(e).slice(0, 200) })
      await blobAppStore.write('runlog', failLog.slice(-200))
      const tok = process.env.TELEGRAM_BOT_TOKEN
      const chat = process.env.TELEGRAM_CHAT_ID
      if (tok && chat) {
        const { sendTelegram } = await import('./lib/telegram')
        await sendTelegram(tok, chat, `🚨 StreetSignal: report compose FAILED before publish — ${String(e).slice(0, 150)}`)
      }
    } catch { /* alert/log is best-effort */ }
    return new Response(String(e), { status: 502 })
  }
}
