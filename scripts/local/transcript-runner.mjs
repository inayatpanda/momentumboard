#!/usr/bin/env node
// The Mac transcript runner (owner directive 2026-08-16). YouTube's caption
// endpoint answers residential IPs and blocks datacenter ones — 30 days of
// production EXTRACT-HEALTH showed free=0 while Gemini watched 49 of 53
// videos. So the fetch moves HERE: launchd runs this hourly from 16:00 to
// 23:00 local (see the plist), it asks the app which videos still need words
// (`GET ?pending=1`), pulls each caption track the same way the YouTube app
// itself does, and hands the text back (`POST`). No LLM anywhere in this
// file, by design.
//
// Install (one-off):
//   cp scripts/local/com.streetsignal.transcripts.plist ~/Library/LaunchAgents/
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.streetsignal.transcripts.plist
// Token: one line in ~/.config/streetsignal/transcript-token (chmod 600),
// matching the TRANSCRIPT_TOKEN secret on the Cloudflare Pages project.

import { readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchCaptionTranscript } from '../../shared/youtubeCaptions.mjs'
import { fetchAudioTranscript } from './audio-transcript.mjs'
import { fetchLibraryCaptions } from './captions-library.mjs'
import { flushTranscripts, retainTranscript } from './transcript-outbox.mjs'

const BASE = process.env.STREETSIGNAL_URL ?? 'https://thestreetsignal.rqai.co.uk'
const TOKEN_FILE = join(homedir(), '.config', 'streetsignal', 'transcript-token')
const token = readFileSync(TOKEN_FILE, 'utf8').trim()
const outbox = fileURLToPath(new URL('../../.local/transcript-outbox/', import.meta.url))
const lock = join(outbox, 'runner.lock')
await mkdir(outbox, { recursive: true, mode: 0o700 })
try { if (Date.now() - (await stat(lock)).mtimeMs > 4 * 3600_000) await rm(lock, { recursive: true }) } catch { /* first run */ }
try { await mkdir(lock) } catch { console.log('another transcript runner is active'); process.exit(0) }
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: { 'x-transcript-token': token, 'content-type': 'application/json', ...init.headers } })
const send = payload => api('/api/video-transcripts', { method: 'POST', body: JSON.stringify(payload) })
const limitFlag = process.argv.indexOf('--limit')
const limit = limitFlag < 0 ? 20 : Math.max(1, Math.min(20, Number(process.argv[limitFlag + 1]) || 20))
const audioLimit = process.argv.includes('--no-audio') ? 0 : 2
let stored = 0, audioAttempts = 0, unavailable = 0
try {
  await send({ status: 'runner-status', running: true }).catch(() => {})
  const retry = await flushTranscripts(outbox, send)
  stored += retry.stored
  const pendingRes = await api('/api/video-transcripts?pending=1')
  if (!pendingRes.ok) throw new Error(`pending list: HTTP ${pendingRes.status}`)
  const { data: pending } = await pendingRes.json()
  const deadline = Date.now() + 50 * 60_000
  for (const v of pending.slice(0, limit)) {
    if (Date.now() > deadline) break
    if (retry.urls.has(v.url)) continue
    let got = await fetchCaptionTranscript(v.url)
    if (got.fail) got = await fetchLibraryCaptions(v.url)
    if (got.fail && audioAttempts < audioLimit) { audioAttempts++; got = await fetchAudioTranscript(v.url) }
    if (got.fail) {
      unavailable++
      console.log(`pending ${v.url} — ${got.fail}`)
      try { await send({ url: v.url, status: 'unavailable' }) } catch { /* retry next run */ }
      continue
    }
    await retainTranscript(outbox, { url: v.url, title: v.title, channel: v.channel, text: got.text, segments: got.segments, language: got.language, automatic: got.automatic, method: got.method ?? 'captions' })
    const result = await flushTranscripts(outbox, send)
    stored += result.stored
    if (result.retained) break // keep the words; avoid hammering a failing app
    await new Promise(r => setTimeout(r, 1500))
  }
  console.log(`done: ${stored} saved, ${unavailable} awaiting captions or audio`)
} catch (e) {
  console.error(e instanceof Error && e.message.startsWith('pending list:') ? e.message : 'runner interrupted; captured transcripts remain in the local outbox')
  process.exitCode = 1
} finally {
  const buffered = (await readdir(outbox)).filter(n => n.endsWith('.json')).length
  await send({ status: 'runner-status', running: false, saved: stored, unavailable, buffered }).catch(() => {})
  await rm(lock, { recursive: true, force: true })
}
