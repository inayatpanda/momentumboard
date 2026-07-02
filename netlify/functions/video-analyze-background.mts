import { blobAppStore, type AppStore } from './lib/store'

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

export type GeminiVideoCall = (videoUrl: string, prompt: string, env: Env) => Promise<string>

interface Env {
  APP_TOKEN?: string
  REPORT_TOKEN?: string
  GEMINI_API_KEY?: string
  GOOGLE_GEMINI_BASE_URL?: string
  SUPADATA_API_KEY?: string
}

export const watchVideo: GeminiVideoCall = async (videoUrl, prompt, env) => {
  const base = env.GOOGLE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'
  const res = await fetch(`${base}/v1beta/models/gemini-2.5-flash:generateContent`, {
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
    if (!env.SUPADATA_API_KEY) return new Response('transcripts-unconfigured', { status: 200 })
    const { fetchTranscript } = await import('./lib/transcripts')
    const { EXTRACT_PROMPT, parseExtract } = await import('./lib/videoTrends')
    const { callLlm } = await import('./ai-insights.mts')
    const extracts = (await store.read<{ url: string; at: number }[]>('video-extracts')) ?? []
    if (extracts.some(e => e.url === body.url)) return new Response('already-extracted', { status: 200 })
    if (extracts.filter(e => nowSec - e.at < 86_400).length >= 15) return new Response('extract-daily-cap', { status: 200 })
    const transcript = await fetchTranscript(body.url, env.SUPADATA_API_KEY)
    if (!transcript) return new Response('no-transcript', { status: 200 })
    try {
      const { text } = await callLlm(EXTRACT_PROMPT(body.title ?? '', body.channel ?? '', transcript), env)
      const extract = parseExtract(text, { url: body.url, title: body.title ?? '', channel: body.channel ?? '', at: nowSec })
      if (!extract) return new Response('unparseable', { status: 200 })
      extracts.push(extract)
      await store.write('video-extracts', extracts.slice(-400))
      const monthKey = `video-extracts:${new Date(nowSec * 1000).toISOString().slice(0, 7)}`
      const archive = (await store.read<unknown[]>(monthKey)) ?? []
      archive.push(extract)
      await store.write(monthKey, archive)
      return new Response('extracted', { status: 200 })
    } catch (e) {
      return new Response(String(e), { status: 502 })
    }
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
