import type { CaptionSegment } from '../../../shared/youtubeCaptions.mjs'
import { SOCIAL_EVIDENCE_VERSION } from '../../../shared/socialEvidence'
import type { AppStore } from './storeProvider'
import { EXTRACT_PROMPT, parseExtract, type VideoExtract } from './videoTrends'

export const TRANSCRIPT_CHUNK_CHARS = 24_000

/** Read every section, with a small overlap so a company/level split at the
 * boundary retains its context. Never silently truncate a long market show. */
export function transcriptChunks(text: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += TRANSCRIPT_CHUNK_CHARS - 200) {
    chunks.push(text.slice(start, start + TRANSCRIPT_CHUNK_CHARS))
    if (start + TRANSCRIPT_CHUNK_CHARS >= text.length) break
  }
  return chunks
}

export class ExtractionPending extends Error {}

export async function extractTranscriptFacts(
  text: string,
  meta: { url: string; title: string; channel: string; at: number },
  audience: string,
  call: (prompt: string) => Promise<string>,
  options: { segments?: CaptionSegment[]; language?: string; store?: AppStore; checkpointKey?: string; maxNewChunks?: number } = {},
): Promise<VideoExtract | null> {
  if (!text.trim() || text.length > 300_000) throw new Error('transcript-size-unsupported')
  const merged: VideoExtract = { ...meta, tickers: [], themes: [], claims: [], evidenceVersion: SOCIAL_EVIDENCE_VERSION }
  const tickers = new Map<string, VideoExtract['tickers'][number]>()
  const themes = new Set<string>()
  const chunks = transcriptChunks(text)
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SOCIAL_EVIDENCE_VERSION + text + JSON.stringify(options.segments ?? []))))).map(n => n.toString(16).padStart(2, '0')).join('')
  const checkpoint = options.checkpointKey ? `${options.checkpointKey}:${digest}` : null
  const parts = checkpoint && options.store ? (await options.store.read<VideoExtract[]>(checkpoint) ?? []) : []
  let calls = 0
  for (let i = 0; i < chunks.length; i++) {
    if (!parts[i] && calls >= (options.maxNewChunks ?? Infinity)) throw new ExtractionPending('extraction-in-progress')
    const raw = parts[i] ? null : await call(EXTRACT_PROMPT(meta.title, meta.channel, chunks[i], i === 0 ? audience : ''))
    const part = parts[i] ?? parseExtract(raw!, meta, chunks[i], options.segments)
    if (!part) return null // do not publish a partial result as a complete read
    if (!parts[i]) {
      calls++
      parts[i] = part
      if (checkpoint && options.store) await options.store.write(checkpoint, parts)
    }
    merged.claims!.push(...(part.claims ?? []))
    for (const ticker of part.tickers) {
      const previous = tickers.get(ticker.sym)
      tickers.set(ticker.sym, previous ? {
        ...previous, ...ticker,
        stance: previous.stance === ticker.stance ? ticker.stance : 'neutral',
        levels: [...new Set([...previous.levels, ...ticker.levels])].slice(0, 16),
        hype: previous.hype || ticker.hype,
      } : ticker)
    }
    for (const theme of part.themes) themes.add(theme)
    if (i === 0 && part.audience) merged.audience = part.audience
  }
  merged.claims = [...new Map(merged.claims!.map(c => [c.id, c])).values()]
  merged.coverage = { textChars: text.length, chunks: chunks.length, analysedChunks: parts.length, timedSegments: (options.segments ?? []).filter(s => s.startSec != null).length, totalSegments: options.segments?.length ?? 0, language: options.language ?? 'und', complete: true, visual: 'not-reviewed' }
  merged.tickers = [...tickers.values()]
  merged.themes = [...themes].slice(0, 6)
  return merged
}
