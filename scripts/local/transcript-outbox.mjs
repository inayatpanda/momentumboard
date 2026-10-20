import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

export async function retainTranscript(dir, payload) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `${videoKey(payload.url)}.json`)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(payload), { mode: 0o600 })
  await rename(temp, target)
}
export async function flushTranscripts(dir, send, log = console.log) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let stored = 0, retained = 0
  const urls = new Set()
  for (const name of (await readdir(dir)).filter(n => /^[\w-]{11}\.json$/.test(n))) {
    try {
      const payload = JSON.parse(await readFile(join(dir, name), 'utf8'))
      urls.add(payload.url)
      const res = await send(payload)
      if (res.ok) { urls.delete(payload.url); await unlink(join(dir, name)); stored++; log(`saved ${payload.url}`) }
      else { retained++; urls.add(payload.url); log(`retained ${payload.url} — HTTP ${res.status}`) }
    } catch { retained++; log(`retained ${name} — submission unavailable`) }
  }
  return { stored, retained, urls }
}
