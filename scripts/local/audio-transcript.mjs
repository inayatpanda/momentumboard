// Optional, local speech recognition. Never uses cookies or a paid API.
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalVideoUrl } from '../../shared/youtubeCaptions.mjs'
const run = promisify(execFile)
const tools = join(homedir(), 'Projects', 'streetsignal-tools')
const downloader = process.env.STREETSIGNAL_YTDLP ?? join(tools, 'venv', 'bin', 'yt-dlp')
const model = process.env.STREETSIGNAL_WHISPER_MODEL ?? join(tools, 'ggml-base.en.bin')
const whisper = process.env.STREETSIGNAL_WHISPER ?? '/opt/homebrew/bin/whisper-cli'
const ffmpeg = process.env.STREETSIGNAL_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

export function parseWhisperTranscript(data) {
  const segments = (data.transcription ?? []).flatMap(row => {
    const text = typeof row.text === 'string' ? row.text.replace(/\[_[^\]]+_\]/g, '').replace(/\s+/g, ' ').trim() : ''
    const startSec = row.offsets?.from / 1000, endSec = row.offsets?.to / 1000
    return text && Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec ? [{ text, startSec, endSec }] : []
  })
  const text = segments.map(s => s.text).join(' ')
  return text.length >= 100 && text.length <= 300_000 ? { text, segments, language: 'en', automatic: true, method: 'speech' } : { fail: 'audio-text-unavailable' }
}

export async function fetchAudioTranscript(url, { deadlineMs = Date.now() + 30 * 60_000, maxDurationSec = 5400 } = {}) {
  const canonical = canonicalVideoUrl(url)
  if (!canonical) return { fail: 'invalid-video' }
  try { await Promise.all([downloader, model, whisper, ffmpeg].map(p => access(p))) } catch { return { fail: 'local-audio-not-configured' } }
  const dir = await mkdtemp(join(tmpdir(), 'streetsignal-audio-'))
  const options = () => {
    const remaining = deadlineMs - Date.now()
    if (remaining <= 0) throw new Error('audio-deadline')
    return { timeout: Math.min(12 * 60_000, remaining), maxBuffer: 1024 * 1024 }
  }
  let stage = 'metadata'
  try {
    // Metadata first: skip live broadcasts, unknown lengths and >90 minutes.
    const { stdout } = await run(downloader, ['--no-playlist', '--socket-timeout', '20', '--retries', '1', '--js-runtimes', 'node', '--print', '{"duration":%(duration)j,"is_live":%(is_live)j}', '--skip-download', '--', canonical], options())
    const info = JSON.parse(stdout)
    if (info.is_live || !Number.isFinite(info.duration) || info.duration > maxDurationSec) return { fail: 'audio-duration-limit' }
    stage = 'download'
    await run(downloader, ['--no-playlist', '--socket-timeout', '20', '--retries', '1', '--fragment-retries', '1', '--js-runtimes', 'node', '--max-filesize', '120M', '-f', 'bestaudio[abr<=160]/bestaudio', '-o', join(dir, 'audio.%(ext)s'), '--', canonical], options())
    const file = (await readdir(dir)).find(f => /^audio\.(webm|m4a|mp3|ogg|opus|mp4)$/.test(f))
    if (!file) return { fail: 'audio-download-unavailable' }
    stage = 'convert'
    await run(ffmpeg, ['-nostdin', '-y', '-i', join(dir, file), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'speech.wav')], options())
    stage = 'transcribe'
    await run(whisper, ['-m', model, '-f', join(dir, 'speech.wav'), '-l', 'en', '-oj', '-of', join(dir, 'result'), '-np', '-ng'], options())
    return parseWhisperTranscript(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')))
  } catch {
    // Errors from external programs can contain tokens/URLs/large HTML. Keep
    // diagnostics categorical. Restricted or unavailable videos remain pending.
    return { fail: `local-audio-${stage}-unavailable` }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
