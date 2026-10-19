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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchCaptionTranscript } from '../../shared/youtubeCaptions.mjs'

const BASE = process.env.STREETSIGNAL_URL ?? 'https://thestreetsignal.rqai.co.uk'
const TOKEN_FILE = join(homedir(), '.config', 'streetsignal', 'transcript-token')

const token = (() => {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    console.error(`no token at ${TOKEN_FILE} — see the header of this file`)
    process.exit(1)
  }
})()

const api = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: { 'x-transcript-token': token, 'content-type': 'application/json', ...init.headers } })

const pendingRes = await api('/api/video-transcripts?pending=1')
if (!pendingRes.ok) {
  console.error(`pending list: HTTP ${pendingRes.status}`)
  process.exit(1)
}
const { data: pending } = await pendingRes.json()
if (!pending.length) {
  console.log('nothing pending')
  process.exit(0)
}

let stored = 0
for (const v of pending) {
  const got = await fetchCaptionTranscript(v.url)
  if (got.fail) {
    // fresh uploads grow auto-captions minutes-to-hours later; the next run
    // simply finds the video still pending — that IS the retry
    console.log(`skip  ${v.url} — ${got.fail}`)
    // Rotate failures behind untried videos instead of monopolising the 20 slots.
    try { await api('/api/video-transcripts', { method: 'POST', body: JSON.stringify({ url: v.url, status: 'unavailable' }) }) } catch { /* next poll retries */ }
    continue
  }
  try {
    const res = await api('/api/video-transcripts', {
      method: 'POST',
      body: JSON.stringify({ url: v.url, title: v.title, channel: v.channel, text: got.text, segments: got.segments, language: got.language, automatic: got.automatic }),
    })
    console.log(`${res.ok ? 'sent ' : 'FAIL '} ${v.url} — ${got.text.length} chars, ${res.status} ${await res.text().catch(() => '')}`)
    if (res.ok) stored++
  } catch {
    console.log(`FAIL  ${v.url} — submission failed; retained in pending inbox for the next run`)
  }
  await new Promise(r => setTimeout(r, 1500)) // be a polite client, not a scraper burst
}
console.log(`done: ${stored}/${pending.length} stored`)
