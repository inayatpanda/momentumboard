import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import type { VideoExtract } from './lib/videoTrends'

// Netlify background function (-background suffix): returns 202 immediately,
// then gets up to 15 minutes — Gemini needs 1-3 min to actually watch a video.

export interface VideoAnalysis {
  url: string
  title: string
  channel: string
  analysis: string
  at: number
  /** 'transcript' = the words were analysed by the text LLM; anything else
   * (including the via-less legacy rows) was a real Gemini video watch. */
  via?: 'transcript' | 'gemini-video'
}

const DAILY_CAP = 3 // total watch-tier analyses per day, whichever rung
// Owner directive 2026-08-16 ("without using up so much gemini/groq"): the
// local transcript store is now the FIRST rung on both tiers, so the Gemini
// video-watch fallbacks shrink to emergency valves. Production data behind it:
// 49 of the week's 53 extracts were gemini-video, free scrape 0 in 30 days.
const GEMINI_WATCH_DAILY_CAP = 1 // was 3 — full narrative watches
const GEMINI_EXTRACT_DAILY_CAP = 2 // was 12 — extraction watches

/** The narrative prompt over a TRANSCRIPT: same contract as the video PROMPT
 * minus the one thing words cannot carry (chart annotations). */
const TRANSCRIPT_PROMPT = (title: string, channel: string, text: string) => `You are reading the transcript of a stock-market YouTube video ("${title}" by ${channel}) for a sceptical swing trader. Report ONLY what is actually said:
1. Tickers discussed.
2. Specific price levels stated (support/resistance/entries/targets) — this matters most.
3. The creator's stance per ticker (bullish/bearish/neutral) and their key argument in one line each.
4. Anything promotional or hype-flagged worth discounting.
Max 180 words. No advice, no embellishment. If the video is not about markets, say so in one line.

TRANSCRIPT:
${text.slice(0, 24_000)}`

export type GeminiVideoCall = (videoUrl: string, prompt: string, env: Env) => Promise<string>

interface Env {
  APP_TOKEN?: string
  REPORT_TOKEN?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GOOGLE_GEMINI_BASE_URL?: string
  SUPADATA_API_KEY?: string
  YOUTUBE_API_KEY?: string
}

export const watchVideo: GeminiVideoCall = async (videoUrl, prompt, env) => {
  const { modelFor, httpErrorFor } = await import('./lib/llm')
  const base = env.GOOGLE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'
  const res = await fetch(`${base}/v1beta/models/${modelFor('gemini', env)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: videoUrl, mimeType: 'video/*' } }, { text: prompt }] }],
    }),
  })
  // audit L-5: keep the real HTTP cause (401/429/404/5xx) instead of a bare
  // 'gemini-video: empty' — the H-3 fix hadn't reached this native-video path.
  const httpErr = await httpErrorFor('gemini-video', res)
  if (httpErr) throw httpErr
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } }
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`gemini-video: ${j.error?.message ?? 'empty'}`)
  return text
}

const PROMPT = `You are watching a stock-market YouTube video for a sceptical swing trader. Report ONLY what is actually said or shown:
1. Tickers discussed (with timestamps if clear).
2. Specific price levels stated OR drawn on charts (support/resistance/entries/targets) — this matters most; read the chart annotations.
3. The creator's stance per ticker (bullish/bearish/neutral) and their key argument in one line each.
4. Anything promotional or hype-flagged worth discounting.
Max 180 words. No advice, no embellishment. If the video is not about markets, say so in one line.`

export async function routeVideoAnalyze(
  headers: Headers,
  bodyText: string | null,
  env: Env,
  store: AppStore,
  watch: GeminiVideoCall = watchVideo,
): Promise<Response> {
  const appOk = !!env.APP_TOKEN && headers.get('x-app-token') === env.APP_TOKEN
  const reportOk = !!env.REPORT_TOKEN && headers.get('x-report-token') === env.REPORT_TOKEN
  if (!appOk && !reportOk) return new Response('unauthorized', { status: 401 })

  const body = bodyText ? (JSON.parse(bodyText) as { url?: string; title?: string; channel?: string; mode?: string }) : null
  if (!body?.url || !/youtube\.com|youtu\.be/.test(body.url)) return new Response('bad-url', { status: 400 })

  const nowSec = Math.floor(Date.now() / 1000)

  // mode=extract — tier-1 breadth: transcript + cheap text extraction → trend store
  if (body.mode === 'extract') {
    // Rungs: the LOCAL transcript store (the Mac runner's residential IP is
    // the one place the caption endpoint reliably answers) → free caption
    // scrape → Supadata (if keyed) → Gemini WATCHES the video (fileData URI —
    // works even when auto-captions don't exist yet on a fresh upload). The
    // worker runs on datacenter IPs, so the scrape failing is the norm, not
    // the exception — the local rung is what makes this tier cheap AND the
    // Gemini valve is what keeps it alive when the Mac is asleep.
    const { fetchTranscriptAny } = await import('./lib/transcripts')
    const { readStoredTranscript, saveTranscript } = await import('./lib/videoTranscriptStore')
    const { fetchYouTubeCommentSample, audiencePrompt } = await import('./lib/youtubeComments')
    const { EXTRACT_PROMPT, EXTRACT_PROMPT_VIDEO, parseExtract } = await import('./lib/videoTrends')
    const { callLlm } = await import('./ai-insights.mts')
    const extracts = (await store.read<VideoExtract[]>('video-extracts')) ?? []
    if (extracts.some(e => e.url === body.url)) return new Response('already-extracted', { status: 200 })
    if (extracts.filter(e => nowSec - e.at < 86_400).length >= 25) return new Response('extract-daily-cap', { status: 200 })
    const local = await readStoredTranscript(store, body.url)
    const got = local ? { text: local.text, source: 'local' as const } : await fetchTranscriptAny(body.url, env.SUPADATA_API_KEY)
    const audienceText = audiencePrompt(await fetchYouTubeCommentSample(body.url, env.YOUTUBE_API_KEY))
    let raw: string | null = null
    let via: 'local' | 'free' | 'supadata' | 'gemini-video' = 'gemini-video'
    if (got) {
      via = got.source // kept distinct so the health line shows which cheap rung actually fired
      if (got.source !== 'local') {
        // the words survive the extraction: whatever rung fetched them, store
        // them — the watch tier and any re-read work from here, fetch-free
        await saveTranscript(store, { url: body.url, title: body.title ?? '', channel: body.channel ?? '', text: got.text, source: got.source, at: nowSec })
      }
      try {
        // DeepSeek-forced: video condensation must not spend the Groq
        // tokens-per-day budget the morning paper composes against
        raw = (await callLlm(EXTRACT_PROMPT(body.title ?? '', body.channel ?? '', got.text, audienceText), { ...env, LLM_PROVIDER: 'openai' })).text
      } catch (e) {
        return new Response(String(e), { status: 502 }) // LLM down — retryable
      }
    } else if (env.GEMINI_API_KEY) {
      const geminiToday = extracts.filter(e => e.via === 'gemini-video' && nowSec - e.at < 86_400).length
      if (geminiToday >= GEMINI_EXTRACT_DAILY_CAP) return new Response('gemini-extract-capped', { status: 200 })
      try {
        raw = await watch(body.url, EXTRACT_PROMPT_VIDEO(body.title ?? '', body.channel ?? '', audienceText), env)
        via = 'gemini-video'
      } catch (e) {
        console.log(`EXTRACT: gemini-video rung failed for ${body.url}: ${String(e).slice(0, 200)}`)
      }
    }
    // Every rung failed: return retryable, NOT a silent 200 — the queue's
    // 3 attempts × 15 min also give a fresh upload time to grow captions.
    if (!raw) return new Response('no-transcript-no-video-read', { status: 503 })
    const extract = parseExtract(raw, { url: body.url, title: body.title ?? '', channel: body.channel ?? '', at: nowSec })
    if (!extract) return new Response('unparseable', { status: 200 })
    extract.via = via
    extracts.push(extract)
    await store.write('video-extracts', extracts.slice(-400))
    const monthKey = `video-extracts:${new Date(nowSec * 1000).toISOString().slice(0, 7)}`
    const archive = (await store.read<unknown[]>(monthKey)) ?? []
    archive.push(extract)
    await store.write(monthKey, archive)
    // Health line: which rung is actually carrying the load over the last 24h.
    // If free+supadata stay 0 and gemini climbs, the cheap tiers are dead and
    // the day's videos beyond the Gemini cap are being dropped — the one signal
    // that used to be invisible until someone grepped the Actions log by hand.
    const last24 = extracts.filter(e => nowSec - e.at < 86_400)
    const n = (v: string) => last24.filter(e => e.via === v).length
    console.log(
      `EXTRACT-HEALTH: read via ${via} | 24h rungs local=${n('local')} free=${n('free')} supadata=${n('supadata')} gemini=${n('gemini-video')}${last24.some(e => e.via === 'transcript') ? ` transcript(legacy)=${n('transcript')}` : ''} | caps: gemini ${GEMINI_EXTRACT_DAILY_CAP}/day, extract 25/day`,
    )
    return new Response(`extracted:${via}`, { status: 200 })
  }
  const list = (await store.read<VideoAnalysis[]>('video-analyses')) ?? []
  if (list.some(v => v.url === body.url)) return new Response('already-analyzed', { status: 200 })
  if (list.filter(v => nowSec - v.at < 86_400).length >= DAILY_CAP) return new Response('daily-cap', { status: 200 })

  // Transcript-first here too — and STORE-ONLY on purpose: the extract job for
  // the same video (queued in the same alert-check cycle) and the Mac runner
  // both feed `video-transcripts`, so scraping again here would just double the
  // blocked-IP noise. No transcript yet ⇒ one real Gemini watch a day; beyond
  // that 503, and by the queue's next attempt the words are usually in.
  const { readStoredTranscript } = await import('./lib/videoTranscriptStore')
  const local = await readStoredTranscript(store, body.url)
  if (local) {
    const { callLlm } = await import('./ai-insights.mts')
    try {
      const { text } = await callLlm(TRANSCRIPT_PROMPT(body.title ?? '', body.channel ?? '', local.text), { ...env, LLM_PROVIDER: 'openai' })
      list.push({ url: body.url, title: body.title ?? '', channel: body.channel ?? '', analysis: text, at: nowSec, via: 'transcript' })
      await store.write('video-analyses', list.slice(-20))
      return new Response('ok:transcript', { status: 200 })
    } catch (e) {
      return new Response(String(e), { status: 502 })
    }
  }
  // via-less rows are the legacy Gemini watches — they count against the valve
  const geminiWatchesToday = list.filter(v => v.via !== 'transcript' && nowSec - v.at < 86_400).length
  if (geminiWatchesToday >= GEMINI_WATCH_DAILY_CAP) return new Response('no-transcript-gemini-watch-capped', { status: 503 })

  try {
    const analysis = await watch(body.url, PROMPT, env)
    list.push({ url: body.url, title: body.title ?? '', channel: body.channel ?? '', analysis, at: nowSec, via: 'gemini-video' })
    await store.write('video-analyses', list.slice(-20))
    return new Response('ok', { status: 200 })
  } catch (e) {
    return new Response(String(e), { status: 502 })
  }
}

export default async (req: Request) =>
  routeVideoAnalyze(
    req.headers,
    await req.text(),
    {
      APP_TOKEN: process.env.APP_TOKEN,
      REPORT_TOKEN: process.env.REPORT_TOKEN,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
      SUPADATA_API_KEY: process.env.SUPADATA_API_KEY,
      YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
    },
    blobAppStore,
  )
