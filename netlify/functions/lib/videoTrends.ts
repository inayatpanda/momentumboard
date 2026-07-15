// Tier-1 breadth: cheap per-video extraction + deterministic cross-channel
// consensus maths. The AI only extracts; the TREND layer is pure code.

export interface VideoExtract {
  url: string
  title: string
  channel: string
  at: number
  tickers: { sym: string; stance: 'bull' | 'bear' | 'neutral'; levels: number[] }[]
  themes: string[]
  via?: 'transcript' | 'gemini-video' // how the facts were read; absent on rows older than the fallback
}

export interface TickerConsensus {
  sym: string
  mentions7d: number
  mentionsPrior7d: number
  channels: number
  bulls: number
  bears: number
  net: number // bulls - bears
  crowded: boolean // heavy one-sided coverage → contrarian warning, not a buy signal
  shifted: boolean // stance balance flipped vs the prior week
}

const WEEK = 7 * 86_400

export function computeConsensus(extracts: VideoExtract[], nowSec: number): { tickers: TickerConsensus[]; themes: { theme: string; count7d: number }[] } {
  const last7 = extracts.filter(e => nowSec - e.at < WEEK)
  const prior7 = extracts.filter(e => nowSec - e.at >= WEEK && nowSec - e.at < 2 * WEEK)

  const bySym = new Map<string, { mentions: number; channels: Set<string>; bulls: number; bears: number }>()
  for (const e of last7) {
    for (const t of e.tickers) {
      const agg = bySym.get(t.sym) ?? { mentions: 0, channels: new Set<string>(), bulls: 0, bears: 0 }
      agg.mentions++
      agg.channels.add(e.channel)
      if (t.stance === 'bull') agg.bulls++
      if (t.stance === 'bear') agg.bears++
      bySym.set(t.sym, agg)
    }
  }
  const priorBySym = new Map<string, { mentions: number; net: number }>()
  for (const e of prior7) {
    for (const t of e.tickers) {
      const agg = priorBySym.get(t.sym) ?? { mentions: 0, net: 0 }
      agg.mentions++
      agg.net += t.stance === 'bull' ? 1 : t.stance === 'bear' ? -1 : 0
      priorBySym.set(t.sym, agg)
    }
  }

  const tickers = [...bySym.entries()]
    .map(([sym, a]): TickerConsensus => {
      const prior = priorBySym.get(sym)
      const net = a.bulls - a.bears
      return {
        sym,
        mentions7d: a.mentions,
        mentionsPrior7d: prior?.mentions ?? 0,
        channels: a.channels.size,
        bulls: a.bulls,
        bears: a.bears,
        net,
        crowded: a.mentions >= 5 && Math.abs(net) >= Math.ceil(a.mentions * 0.7),
        shifted: !!prior && prior.net !== 0 && net !== 0 && Math.sign(prior.net) !== Math.sign(net),
      }
    })
    .sort((a, b) => b.mentions7d - a.mentions7d)

  const themeCounts = new Map<string, number>()
  for (const e of last7) for (const th of e.themes) themeCounts.set(th, (themeCounts.get(th) ?? 0) + 1)
  const themes = [...themeCounts.entries()]
    .map(([theme, count7d]) => ({ theme, count7d }))
    .sort((a, b) => b.count7d - a.count7d)
    .slice(0, 8)

  return { tickers, themes }
}

const EXTRACT_PROMPT = (title: string, channel: string, transcript: string) => `Extract facts from this stock-video transcript. Respond with ONLY valid JSON, no prose:
{"tickers":[{"sym":"TSLA","stance":"bull|bear|neutral","levels":[180.5]}],"themes":["ai-capex","rate-cuts"]}
Rules: tickers = actual stock/crypto symbols discussed with a view (not passing mentions); stance = the creator's stated view; levels = specific prices they cite for that ticker; themes = up to 3 kebab-case investment themes. Video: "${title}" by ${channel}. Transcript (may be truncated):\n${transcript.slice(0, 24_000)}`

/** The transcript-less variant: Gemini watches the video itself (fileData URI),
 * so the rules also cover levels DRAWN on charts, which transcripts never carry.
 * Same JSON contract — parseExtract handles both. */
const EXTRACT_PROMPT_VIDEO = (title: string, channel: string) => `Watch this stock-market video and extract facts. Respond with ONLY valid JSON, no prose:
{"tickers":[{"sym":"TSLA","stance":"bull|bear|neutral","levels":[180.5]}],"themes":["ai-capex","rate-cuts"]}
Rules: tickers = actual stock/crypto symbols discussed with a view (not passing mentions); stance = the creator's stated view; levels = specific prices they say OR draw on charts for that ticker; themes = up to 3 kebab-case investment themes. If the video is not about markets, return {"tickers":[],"themes":[]}. Video: "${title}" by ${channel}.`

export function parseExtract(raw: string, meta: { url: string; title: string; channel: string; at: number }): VideoExtract | null {
  try {
    const json = raw.match(/\{[\s\S]*\}/)?.[0]
    if (!json) return null
    const p = JSON.parse(json) as { tickers?: { sym?: string; stance?: string; levels?: number[] }[]; themes?: string[] }
    return {
      ...meta,
      tickers: (p.tickers ?? [])
        .filter(t => typeof t.sym === 'string')
        .slice(0, 10)
        .map(t => ({
          sym: t.sym!.toUpperCase().slice(0, 12),
          stance: t.stance === 'bull' || t.stance === 'bear' ? t.stance : 'neutral',
          levels: (t.levels ?? []).filter(l => typeof l === 'number').slice(0, 8),
        })),
      themes: (p.themes ?? []).filter(t => typeof t === 'string').slice(0, 3),
    }
  } catch {
    return null
  }
}

export { EXTRACT_PROMPT, EXTRACT_PROMPT_VIDEO }
