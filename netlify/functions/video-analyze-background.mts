import { blobAppStore, type AppStore } from './lib/store'
import type { VideoExtract } from './lib/videoTrends'

// Netlify background function (-background suffix): returns 202 immediately,
// then gets up to 15 minutes — Gemini needs 1-3 min to actually watch a video.

export interface VideoAnalysis {
  url: string
  title: string
  channel: string
  analysis: string
  at: number
}

const DAILY_CAP = 3 // watching video burns AI-gateway credits fast; cap it
// The extract tier's transcript-less fallback also watches the video (Gemini),
// but produces a tiny JSON — cheaper than the narrative tier, so a higher cap.
const GEMINI_EXTRACT_DAILY_CAP = 12

export type GeminiVideoCall = (videoUrl: string, prompt: string, env: Env) => Promise<string>

interface Env {
  APP_TOKEN?: string
  REPORT_TOKEN?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GOOGLE_GEMINI_BASE_URL?: string
  SUPADATA_API_KEY?: string
}

export const watchVideo: GeminiVideoCall = async (videoUrl, prompt, env) => {
  const { modelFor } = await import('./lib/llm')
  const base = env.GOOGLE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'
  const res = await fetch(`${base}/v1beta/models/${modelFor('gemini', env)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: videoUrl, mimeType: 'video/*' } }, { text: prompt }] }],
    }),
  })
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
    // Rungs: free caption scrape → Supadata (if keyed) → Gemini WATCHES the
    // video (fileData URI — YouTube can't block Google's own fetch, and it
    // also works when auto-captions simply don't exist yet on a fresh upload).
    // The worker runs on datacenter IPs, so the scrape failing is the norm,
    // not the exception — the Gemini rung is what makes this tier reliable.
    const { fetchTranscriptAny } = await import('./lib/transcripts')
    const { EXTRACT_PROMPT, EXTRACT_PROMPT_VIDEO, parseExtract } = await import('./lib/videoTrends')
    const { callLlm } = await import('./ai-insights.mts')
    const extracts = (await store.read<VideoExtract[]>('video-extracts')) ?? []
    if (extracts.some(e => e.url === body.url)) return new Response('already-extracted', { status: 200 })
    if (extracts.filter(e => nowSec - e.at < 86_400).length >= 25) return new Response('extract-daily-cap', { status: 200 })
    const got = await fetchTranscriptAny(body.url, env.SUPADATA_API_KEY)
    let raw: string | null = null
    let via: 'free' | 'supadata' | 'gemini-video' = 'gemini-video'
    if (got) {
      via = got.source // 'free' (caption scrape) or 'supadata' — kept distinct so the health line shows which cheap rung actually fired
      try {
        raw = (await callLlm(EXTRACT_PROMPT(body.title ?? '', body.channel ?? '', got.text), env)).text
      } catch (e) {
        return new Response(String(e), { status: 502 }) // LLM down — retryable
      }
    } else if (env.GEMINI_API_KEY) {
      const geminiToday = extracts.filter(e => e.via === 'gemini-video' && nowSec - e.at < 86_400).length
      if (geminiToday >= GEMINI_EXTRACT_DAILY_CAP) return new Response('gemini-extract-capped', { status: 200 })
      try {
        raw = await watch(body.url, EXTRACT_PROMPT_VIDEO(body.title ?? '', body.channel ?? ''), env)
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
      `EXTRACT-HEALTH: read via ${via} | 24h rungs free=${n('free')} supadata=${n('supadata')} gemini=${n('gemini-video')}${last24.some(e => e.via === 'transcript') ? ` transcript(legacy)=${n('transcript')}` : ''} | caps: gemini ${GEMINI_EXTRACT_DAILY_CAP}/day, extract 25/day`,
    )
    return new Response(`extracted:${via}`, { status: 200 })
  }
  const list = (await store.read<VideoAnalysis[]>('video-analyses')) ?? []
  if (list.some(v => v.url === body.url)) return new Response('already-analyzed', { status: 200 })
  if (list.filter(v => nowSec - v.at < 86_400).length >= DAILY_CAP) return new Response('daily-cap', { status: 200 })

  try {
    const analysis = await watch(body.url, PROMPT, env)
    list.push({ url: body.url, title: body.title ?? '', channel: body.channel ?? '', analysis, at: nowSec })
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
    },
    blobAppStore,
  )
