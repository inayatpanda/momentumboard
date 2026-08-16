#!/usr/bin/env node
// The Mac transcript runner (owner directive 2026-08-16). YouTube's caption
// endpoint answers residential IPs and blocks datacenter ones — 30 days of
// production EXTRACT-HEALTH showed free=0 while Gemini watched 49 of 53
// videos. So the fetch moves HERE: launchd runs this every 30 minutes, it
// asks the app which videos still need words (`GET ?pending=1`), pulls each
// caption track the same way the YouTube app itself does, and hands the text
// back (`POST`). No LLM anywhere in this file, by design.
//
// Install (one-off):
//   cp scripts/local/com.streetsignal.transcripts.plist ~/Library/LaunchAgents/
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.streetsignal.transcripts.plist
// Token: one line in ~/.config/streetsignal/transcript-token (chmod 600),
// matching the TRANSCRIPT_TOKEN secret on the Cloudflare Pages project.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'

const videoIdFrom = url => url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null

/** Same track choice as netlify/functions/lib/transcripts.ts: human english
 * beats auto english beats whatever exists. */
const pickTrack = tracks => {
  const en = tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr')
  return en ?? tracks.find(t => t.languageCode?.startsWith('en')) ?? tracks[0] ?? null
}

const parseTimedText = xml => {
  const parts = []
  for (const m of xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = m[1].replace(/<[^>]+>/g, '')
    if (text.trim()) parts.push(text)
  }
  return parts
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchCaptions(url) {
  const id = videoIdFrom(url)
  if (!id) return { fail: 'bad-url' }
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } }, videoId: id }),
  })
  if (!res.ok) return { fail: `innertube ${res.status}` }
  const j = await res.json()
  const track = pickTrack(j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
  if (!track) return { fail: 'no-caption-tracks' }
  const cap = await fetch(track.baseUrl, { headers: { 'user-agent': ANDROID_UA } })
  if (!cap.ok) return { fail: `timedtext ${cap.status}` }
  const text = parseTimedText(await cap.text())
  return text.length > 100 ? { text } : { fail: `too-short (${text.length})` }
}

const api = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { 'x-transcript-token': token, 'content-type': 'application/json', ...init.headers } })

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
  const got = await fetchCaptions(v.url)
  if (got.fail) {
    // fresh uploads grow auto-captions minutes-to-hours later; the next run
    // simply finds the video still pending — that IS the retry
    console.log(`skip  ${v.url} — ${got.fail}`)
    continue
  }
  const res = await api('/api/video-transcripts', {
    method: 'POST',
    body: JSON.stringify({ url: v.url, title: v.title, channel: v.channel, text: got.text }),
  })
  console.log(`${res.ok ? 'sent ' : 'FAIL '} ${v.url} — ${got.text.length} chars, ${res.status} ${await res.text().catch(() => '')}`)
  if (res.ok) stored++
  await new Promise(r => setTimeout(r, 1500)) // be a polite client, not a scraper burst
}
console.log(`done: ${stored}/${pending.length} stored`)
