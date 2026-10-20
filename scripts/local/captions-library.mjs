import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { videoKey, canonicalVideoUrl } from '../../shared/youtubeCaptions.mjs'
const run = promisify(execFile)
export async function fetchLibraryCaptions(url) {
  if (!canonicalVideoUrl(url)) return { fail: 'invalid-video' }
  try {
    const { stdout } = await run(process.env.STREETSIGNAL_PYTHON ?? join(homedir(), 'Projects', 'streetsignal-tools', 'venv', 'bin', 'python'),
      [fileURLToPath(new URL('./captions-python.py', import.meta.url)), videoKey(url)], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    return JSON.parse(stdout)
  } catch { return { fail: 'caption-library-unavailable' } }
}
