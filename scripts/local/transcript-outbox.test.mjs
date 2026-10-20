import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retainTranscript, flushTranscripts } from './transcript-outbox.mjs'
import { parseWhisperTranscript } from './audio-transcript.mjs'

test('failed uploads retain the original text until a successful retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-test-'))
  const payload = { url: 'https://youtu.be/abcdefghijk', text: 'Saved caption words. '.repeat(20) }
  try {
    await retainTranscript(dir, payload)
    const failed = await flushTranscripts(dir, async () => new Response('', { status: 500 }), () => {})
    assert.equal(failed.retained, 1)
    let received
    const retry = await flushTranscripts(dir, async p => { received = p; return new Response('stored') }, () => {})
    assert.deepEqual(received, payload)
    assert.equal(retry.stored, 1)
    assert.equal((await readdir(dir)).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('local speech segments preserve real millisecond offsets', () => {
  const result = parseWhisperTranscript({ transcription: [{ text: 'Financial results improved over the previous year. '.repeat(4), offsets: { from: 1500, to: 8500 } }] })
  assert.equal(result.method, 'speech')
  assert.equal(result.segments[0].startSec, 1.5)
  assert.equal(result.segments[0].endSec, 8.5)
  assert.equal(parseWhisperTranscript({ transcription: [] }).fail, 'audio-text-unavailable')
})
