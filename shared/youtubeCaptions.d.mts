export function videoIdFrom(value: unknown): string | null
export function canonicalVideoUrl(value: unknown): string | null
export function videoKey(value: string): string
export function pickTrack<T extends { languageCode?: string; kind?: string }>(tracks: T[]): T | null
export interface CaptionSegment { text: string; startSec?: number; endSec?: number }
export function parseCaptionSegments(body: string): CaptionSegment[]
export function parseTimedText(body: string): string
export function fetchCaptionTranscript(videoUrl: string, fetchFn?: typeof fetch): Promise<{ text: string; segments: CaptionSegment[]; language: string; automatic: boolean; fail?: never } | { fail: string; text?: never }>
