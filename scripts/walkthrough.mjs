#!/usr/bin/env node
// THE PRE-CUTOVER WALKTHROUGH (plan Task 23) — never deploy blind, made
// executable. This is the gate the v2 shell must pass before Task 24's flip
// and again after Task 24's deletions.
//
//   npm run walkthrough                 # both viewports
//   npm run walkthrough -- --viewport=phone
//   npm run walkthrough -- --no-build   # reuse the dist/ already on disk
//
// WHAT IT ASSERTS, AND WHY THAT IS THE RIGHT THING TO ASSERT
//
// The preview store is EMPTY. `wrangler pages dev` gets STORE_BACKEND=blobs
// with no Netlify credentials, which lib/store.ts degrades to the in-memory
// store (wrangler.toml's `[env.preview]` comment spells out the same choice
// for real preview deploys). So every view returns nulls, and that is the
// point: this harness validates THE SHELL, not data richness. Skeletons and
// empty states everywhere, a heading on every screen, never a crash, never a
// blank page, never a bounce to the licence gate. A screen that only survives
// when the engine had a good morning is a screen that will break on a bad one.
//
// WHY NOT `vite preview` (DS-25). It serves dist/ and NOTHING else — no
// /api/*, so every screen would render its offline/error branch and the walk
// would prove nothing about the real thing. `wrangler pages dev dist` runs
// functions/api/[[route]].ts against the same router the deploy uses.
//
// WHY HARD REFRESHES (CX-11). Client-side navigation only exercises wouter.
// The deep links that matter — a shared /app/stock/NVDA, an installed PWA
// cold-opening its start_url, a typo'd path — arrive as real HTTP requests
// that Cloudflare Pages must answer with index.html (200, not 404). Pages does
// that by default ONLY while dist/ has no top-level 404.html; wrangler.toml's
// header explains it at length. Every stop here is a full document load.
//
// WHY NO DEPENDENCIES. `chrome --headless=new --remote-debugging-port` plus
// raw CDP. Node 22+ ships a global WebSocket, so the whole client is the ~40
// lines of `Cdp` below — nothing to install, nothing to keep in step with a
// Chrome release, nothing new in package.json before a cutover.
//
// EXIT CODE. Non-zero on any failed assertion, any uncaught exception, any
// console.error, and any 401/403/5xx from the app's own API. Screenshots land
// in .superpowers/walkthrough/ (gitignored) — read them by eye before the flip.
//
// PROVE THE GATE CAN FAIL BEFORE TRUSTING IT. Point the client at a wrong
// token (change the `mb-token` line in the init script) and re-run: 11 of 12
// stops must go red. The first version of this file went 12/12 GREEN in that
// state — App.tsx's 15-minute `mb-token-at` grace kept a rejected device on
// the shell, every screen rendered its empty branch, and every assertion was
// satisfied by a session the server had refused. That is why 401 is a failure
// here and not a note.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const OUT_DIR = join(ROOT, '.superpowers', 'walkthrough')
const PORT = Number(process.env.WALKTHROUGH_PORT ?? 8788)
const ORIGIN = `http://127.0.0.1:${PORT}`
const TOKEN = process.env.WALKTHROUGH_TOKEN ?? 'walkthrough-test-token'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const NAV_TIMEOUT = 20_000
const ASSERT_TIMEOUT = 15_000

const args = process.argv.slice(2)
const NO_BUILD = args.includes('--no-build')
const KEEP = args.includes('--keep-server') // leave wrangler up for manual poking
const viewportArg = (args.find(a => a.startsWith('--viewport=')) ?? '').split('=')[1]

// Console errors we log but do not fail on. EMPTY, and it should stay that
// way: an allow-list is where a walkthrough goes to die. The licence-check
// noise this was written to excuse turned out not to exist — the empty store
// answers the admin token 200 — and a 401 is now a hard failure below, so
// excusing one here would contradict the harness's own gate. Anything added
// needs a `why` a reader can argue with.
const ALLOWED_ERRORS = []

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ───────────────────────────── CDP over the built-in WebSocket ──────────────

class Cdp {
  #ws
  #next = 1
  #pending = new Map()
  #listeners = new Map()

  static async attach(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error(`CDP websocket refused: ${url}`)), { once: true })
    })
    const cdp = new Cdp()
    cdp.#ws = ws
    ws.addEventListener('message', ev => cdp.#dispatch(String(ev.data)))
    return cdp
  }

  #dispatch(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id != null) {
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
      else p.res(msg.result)
      return
    }
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params ?? {})
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.#ws.send(JSON.stringify(payload))
    return new Promise((res, rej) => this.#pending.set(id, { res, rej, method }))
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, [])
    this.#listeners.get(method).push(fn)
  }

  /** Resolve on the next occurrence of `method` (or reject on timeout). */
  once(method, timeout = NAV_TIMEOUT) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), timeout)
      this.on(method, params => {
        clearTimeout(timer)
        res(params)
      })
    })
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* already gone */
    }
  }
}

// ───────────────────────────────── the server ───────────────────────────────

async function portAnswers() {
  try {
    const res = await fetch(`${ORIGIN}/app/`, { signal: AbortSignal.timeout(2000) })
    return res.status === 200
  } catch {
    return false
  }
}

async function startServer(log) {
  // --binding beats wrangler.toml's [vars]: STORE_BACKEND=blobs with no
  // Netlify credentials IS the in-memory store, and it also stops
  // configureStoreFromEnv reaching for a local D1 that has no schema.
  const child = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'dist', '--port', String(PORT), '--binding', `APP_TOKEN=${TOKEN}`, '--binding', 'STORE_BACKEND=blobs', '--log-level', 'warn'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APP_TOKEN: TOKEN, STORE_BACKEND: 'blobs' } },
  )
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  for (let i = 0; i < 60; i++) {
    if (await portAnswers()) return child
    if (child.exitCode != null) throw new Error(`wrangler exited (${child.exitCode}):\n${log.join('')}`)
    await sleep(1000)
  }
  throw new Error(`wrangler never answered on ${ORIGIN}:\n${log.join('')}`)
}

/** Best-effort seed so the screens have SOMETHING to draw. Never fatal — the
 *  empty-store walk is the real assertion, this only makes the screenshots a
 *  little less bleak.
 *
 *  A WATCHLIST IS ALL WE CAN SEED, and that is a good property, not a gap: no
 *  endpoint lets a caller write the engine's board, funnel or ledger, so the
 *  board-shaped screens are honestly empty here and the assertions below say
 *  so out loud rather than pretending. */
async function seed() {
  try {
    const res = await fetch(`${ORIGIN}/api/config`, {
      method: 'PUT',
      headers: { 'x-app-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ watchlist: [{ symbol: 'NVDA' }, { symbol: 'AAPL' }, { symbol: 'MSFT' }], rules: [], ytChannels: [] }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok ? 'watchlist seeded (board/funnel/ledger have no write endpoint — empty by design)' : `skipped (config PUT ${res.status})`
  } catch (e) {
    return `skipped (${e.message})`
  }
}

// ───────────────────────────────── the walk ─────────────────────────────────

const VIEWPORTS = {
  phone: { name: 'phone', width: 390, height: 844 },
  desk: { name: 'desk', width: 1440, height: 900 },
}

const hasHeading = text => `[...document.querySelectorAll('h1')].some(h => h.textContent.trim().startsWith(${JSON.stringify(text)}))`

/** Every stop is checked for these before its own assertions: the shell is
 *  mounted, and the licence gate did NOT eat the session. A bounce to AppGate
 *  means the walkthrough token failed to authenticate — a hard failure, never
 *  a warning. */
const UNIVERSAL = [
  ['v2 shell mounted', `!!document.querySelector('.v2')`],
  ['not bounced to the licence gate', `!document.querySelector('.app-gate')`],
  ['page is not blank', `document.body.innerText.trim().length > 0`],
]

function stopsFor(vp) {
  const desk = vp.name === 'desk'
  const stops = [
    {
      name: 'today',
      go: '/app/',
      assert: [['Today heading', hasHeading('Today')], ...(desk ? [['desk grid', `!!document.querySelector('.desk2')`], ['three desk regions', `!!document.querySelector('.desk2-rail') && !!document.querySelector('.desk2-board') && !!document.querySelector('.desk2-detail')`]] : [['bottom tabs', `!!document.querySelector('.v2-nav')`]])],
    },
    { name: 'board', go: '/app/board', assert: [[desk ? 'board column present' : 'Board heading', desk ? `!!document.querySelector('.desk2-board')` : hasHeading('Board')]] },
    {
      // CX-11: a HARD load, hash and all — the chip in Today's counts rail is
      // a shareable URL, and an installed PWA can cold-open on it.
      name: 'board-refused',
      go: '/app/board#refused',
      assert: [
        ['hard-loaded hash deep link served the SPA', `!document.getElementById('main-frame-error')`],
        ['hash survived the round trip', `location.hash === '#refused'`],
        // The <details> only exists once the board slice yields a DATE (the
        // funnel day pairs with the board's own date, DS-17). The preview
        // store has no board, so the honest answer there is "still loading" —
        // what must never happen is a board screen that renders neither.
        [
          'refused section open, or the board honestly mid-load',
          `(() => {
            const d = document.querySelector('details#refused')
            if (d) return d.open === true || 'refused section present but the #refused hash did not open it'
            if (document.querySelectorAll('.skeleton').length > 0) return true
            return 'no refused section and no skeleton — the board rendered nothing at all'
          })()`,
        ],
      ],
      probes: [
        ['landed at', `location.href.replace(location.origin, '') + ' · h1=' + [...document.querySelectorAll('h1')].map(h => h.textContent.trim()).join('|')`],
        ['refused section', `document.querySelector('details#refused') ? 'rendered and open' : 'absent — the empty preview store has no board date to pair a funnel day with'`],
      ],
    },
    { name: 'stocks', go: '/app/stocks', assert: [['Stocks heading', hasHeading('Stocks')]] },
    {
      name: 'stock-nvda',
      go: '/app/stock/NVDA',
      assert: [
        ['SPA fallback served the deep link (h1 carries NVDA)', `[...document.querySelectorAll('h1')].some(h => h.textContent.includes('NVDA'))`],
        ['exactly one price chart region', `document.querySelectorAll('.sp-chart').length === 1`],
      ],
      // Live quote/candles come from Yahoo (keyless), so a network-isolated
      // run legitimately shows the skeleton — recorded, never asserted.
      probes: [['live market data', `document.querySelector('.sp-px') ? 'quote rendered: ' + document.querySelector('.sp-px').innerText.replace(/\\s+/g, ' ') : 'no quote — market fetch empty or unavailable'`]],
    },
    { name: 'intel', go: '/app/intel', assert: [['Intel heading', hasHeading('Intel')]] },
    { name: 'record', go: '/app/record', assert: [['Track record heading', hasHeading('Track record')]] },
    { name: 'more', go: '/app/more', assert: [['More heading', hasHeading('More')]] },
    { name: 'settings', go: '/app/settings', assert: [['Settings heading', hasHeading('Settings')]] },
    {
      name: 'unknown-path',
      go: '/app/zzz',
      assert: [
        ['unknown deep link served index.html, not a 404', `!document.getElementById('main-frame-error')`],
        ['catch-all landed on Today', `location.pathname === '/app/' && ${hasHeading('Today')}`],
      ],
    },
    {
      name: 'theme-toggle',
      go: '/app/settings',
      // Settings' Appearance group is the canonical picker (lib/theme.ts also
      // backs More's cycle row) — click it the way a reader would and watch
      // <html data-theme> follow.
      run: async page => {
        const flip = async label => {
          const r = await page.eval(`(() => {
            const seg = document.querySelector('.seg[aria-label="Theme"]')
            if (!seg) return 'no-theme-seg'
            const b = [...seg.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
            if (!b) return 'no-' + ${JSON.stringify(label)} + '-button'
            b.click()
            return document.documentElement.dataset.theme ?? 'unset'
          })()`)
          return r
        }
        const light = await flip('Light')
        const dark = await flip('Dark')
        return { light, dark }
      },
      assert: [
        ['dataset.theme is dark after the flip', `document.documentElement.dataset.theme === 'dark'`],
        ['theme picker reflects the choice', `!!document.querySelector('.seg[aria-label="Theme"] button[aria-pressed="true"]')`],
      ],
      checkRun: r => (r.light === 'light' && r.dark === 'dark' ? null : `theme did not flip both ways (Light→${r.light}, Dark→${r.dark})`),
    },
    {
      name: 'offline-reload',
      go: '/app/',
      // The precache must carry the shell. Offline is not "show an error
      // nicely" — it is "the app still opens", which is the whole reason this
      // thing is a PWA.
      run: async page => {
        const sw = await page.eval(
          `(async () => {
            if (!('serviceWorker' in navigator)) return 'unsupported'
            await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 8000))])
            return navigator.serviceWorker.controller ? 'controlling' : 'registered-not-controlling'
          })()`,
          true,
        )
        // A first-load SW activates but does not claim (sw.ts: no
        // clientsClaim, by design) — one more real navigation puts the
        // document under its control, which is exactly what a returning
        // reader does.
        if (sw !== 'controlling') await page.goto('/app/')
        const sw2 = await page.eval(`navigator.serviceWorker.controller ? 'controlling' : 'uncontrolled'`)
        await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
        await page.reload()
        return { sw: sw2 }
      },
      assert: [
        ['no browser network-error page', `!document.getElementById('main-frame-error')`],
        ['shell still painted from the precache', `!!document.querySelector('.v2') && ${hasHeading('Today')}`],
        ['content or skeletons, not an empty column', `document.querySelectorAll('.today .skeleton, .today .card, .desk2-board .skeleton, .desk2-board .card').length > 0 || document.body.innerText.trim().length > 40`],
      ],
      checkRun: r => (r.sw === 'controlling' ? null : `service worker never took control (${r.sw}) — the offline reload proves nothing`),
      quietNetwork: true,
    },
  ]
  return stops
}

async function runViewport(vp, results) {
  const profile = mkdtempSync(join(tmpdir(), `ss-walkthrough-${vp.name}-`))
  const cdpPort = 9333 + (vp.name === 'desk' ? 1 : 0)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      `--window-size=${vp.width},${vp.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp = null
  const cleanup = () => {
    cdp?.close()
    try {
      chrome.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  try {
    // wait for the DevTools endpoint
    let wsUrl = null
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })
        wsUrl = (await r.json()).webSocketDebuggerUrl
        if (wsUrl) break
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }
    if (!wsUrl) throw new Error(`Chrome never opened a DevTools endpoint on ${cdpPort} (CHROME_BIN=${CHROME})`)

    cdp = await Cdp.attach(wsUrl)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

    const problems = []
    const netNotes = []
    const authFailures = []
    const serverErrors = []
    const send = (m, p) => cdp.send(m, p, sessionId)

    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type !== 'error') return
      problems.push({ kind: 'console.error', text: (p.args ?? []).map(a => a.description ?? a.value ?? a.unserializableValue ?? a.type).join(' ') })
    })
    cdp.on('Runtime.exceptionThrown', p => {
      const d = p.exceptionDetails ?? {}
      problems.push({ kind: 'exception', text: d.exception?.description ?? d.text ?? 'unknown exception' })
    })
    // 401 IS A FAILURE, NOT A NOTE — the lesson from this harness's own first
    // negative test. `mb-token-at` is stamped fresh on every load, so App.tsx's
    // 15-minute grace window (App.tsx:90-91) keeps a device with a WRONG token
    // on the shell instead of bouncing it to AppGate: every screen then renders
    // its empty branch and every assertion above passes. The walk was green
    // against a token the server rejected outright. Absence of the gate proves
    // nothing; the only proof that the licence works is that the licensed calls
    // came back 200.
    cdp.on('Network.responseReceived', p => {
      const status = p.response?.status ?? 0
      if (status < 400) return
      const line = `${status} ${p.response.url.replace(ORIGIN, '')}`
      if (status === 401 || status === 403) authFailures.push(line)
      else if (status >= 500) serverErrors.push(line)
      else netNotes.push(line) // 404s: an empty store genuinely has no paper yet
    })

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false })
    // The flag + the licence, before a single byte of app code runs. Wrapped:
    // about:blank is an opaque origin and localStorage throws there.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try {
        localStorage.setItem('mb-shell', 'v2');
        localStorage.setItem('mb-token', ${JSON.stringify(TOKEN)});
        localStorage.setItem('mb-token-at', String(Date.now()));
      } catch (e) {}`,
    })

    const page = {
      send,
      async eval(expression, awaitPromise = /await|async/.test(expression)) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      },
      async nav(url, timeout = NAV_TIMEOUT) {
        const load = cdp.once('Page.loadEventFired', timeout)
        await send('Page.navigate', { url })
        await load
      },
      /** A COLD LOAD EVERY TIME (CX-11) — the SPA fallback, the service
       *  worker's navigation route and the screen's own first paint, exercised
       *  at every single stop rather than only at the ones we remembered to
       *  mark. Routing through about:blank is what makes it unconditional:
       *  navigating straight from /app/board to /app/board#refused is a
       *  SAME-document fragment change that `Page.navigate` commits
       *  asynchronously, so a reload chased after it raced the commit and
       *  reloaded the hashless URL — the walk then "passed" a deep link it had
       *  never actually loaded. */
      async goto(path) {
        await this.nav('about:blank', 5000).catch(() => {})
        await this.nav(ORIGIN + path)
        await this.settle()
      },
      async reload() {
        const load = cdp.once('Page.loadEventFired')
        await send('Page.reload', { ignoreCache: false })
        await load
        await this.settle()
      },
      /** React mounts, lazy chunks resolve, slices paint from Dexie. Poll for
       *  the shell rather than guess a sleep. */
      async settle() {
        const until = Date.now() + 8000
        while (Date.now() < until) {
          const ok = await this.eval(`!!document.querySelector('.v2') || !!document.querySelector('.app-gate') || !!document.getElementById('main-frame-error')`).catch(() => false)
          if (ok) break
          await sleep(100)
        }
        await sleep(600) // let the first paint of lazy content land
      },
      async waitFor(expression, timeout = ASSERT_TIMEOUT) {
        const until = Date.now() + timeout
        let last
        for (;;) {
          try {
            last = await this.eval(expression)
          } catch (e) {
            last = `threw: ${e.message}`
          }
          if (last === true) return true
          if (Date.now() > until) return last
          await sleep(150)
        }
      },
      async shot(file) {
        const r = await send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(file, Buffer.from(r.data, 'base64'))
      },
    }

    const stops = stopsFor(vp)
    for (const [i, stop] of stops.entries()) {
      const label = `${vp.name}/${stop.name}`
      const nn = String(i + 1).padStart(2, '0')
      problems.length = 0
      netNotes.length = 0
      authFailures.length = 0
      serverErrors.length = 0
      const failures = []
      const probes = []
      let runResult = null

      try {
        if (stop.go) await page.goto(stop.go)
        if (stop.run) runResult = await stop.run(page)
        if (stop.run && !stop.go) await page.settle()
        if (stop.checkRun) {
          const msg = stop.checkRun(runResult)
          if (msg) failures.push(msg)
        }
        for (const [desc, expr] of [...UNIVERSAL, ...stop.assert]) {
          const got = await page.waitFor(expr)
          if (got !== true) failures.push(`${desc} — got ${JSON.stringify(got)}`)
        }
        for (const [desc, expr] of stop.probes ?? []) {
          probes.push(`${desc}: ${await page.eval(expr).catch(e => `probe threw: ${e.message}`)}`)
        }
      } catch (e) {
        failures.push(`stop threw: ${e.message}`)
      }

      try {
        await page.shot(join(OUT_DIR, `${vp.name}-${nn}-${stop.name}.png`))
      } catch (e) {
        failures.push(`screenshot failed: ${e.message}`)
      }

      const allowed = []
      for (const p of problems) {
        const hit = ALLOWED_ERRORS.find(a => a.re.test(p.text))
        if (hit) allowed.push(`${p.text} [allowed: ${hit.why}]`)
        else failures.push(`${p.kind}: ${p.text}`)
      }
      if (!stop.quietNetwork) {
        for (const a of new Set(authFailures)) failures.push(`the walkthrough licence was REJECTED: HTTP ${a}`)
        for (const s of new Set(serverErrors)) failures.push(`server error: HTTP ${s}`)
      }

      results.push({
        stop: label,
        pass: failures.length === 0,
        failures,
        allowed,
        probes,
        net: stop.quietNetwork ? [] : [...new Set(netNotes)],
      })
      console.log(`  ${failures.length === 0 ? '✓' : '✗'} ${label}`)
      for (const f of failures) console.log(`      ${f}`)
    }
  } finally {
    cleanup()
  }
}

// ─────────────────────────────────── main ───────────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  if (!NO_BUILD) {
    console.log('\n▸ build')
    const code = await new Promise(res => spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' }).on('exit', res))
    if (code !== 0) {
      console.error('build failed — nothing to walk')
      process.exit(1)
    }
  }

  console.log(`\n▸ wrangler pages dev dist --port ${PORT} (STORE_BACKEND=blobs → in-memory, EMPTY by design)`)
  const log = []
  const server = await startServer(log)
  let exiting = false
  const stopServer = () => {
    if (exiting) return
    exiting = true
    try {
      server.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  process.on('exit', stopServer)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => (stopServer(), process.exit(130)))

  // The licence, proved before a browser opens. `authenticate()` treats
  // APP_TOKEN as the admin licence (lib/auth.ts:43-46); if that is not true
  // here, every stop below would walk an unauthenticated shell and pass anyway.
  const who = await fetch(`${ORIGIN}/api/licences?check=1`, { headers: { 'x-app-token': TOKEN } })
  if (!who.ok) {
    console.error(`  the walkthrough token does not authenticate (HTTP ${who.status}) — APP_TOKEN never reached the dev server. Nothing below would mean anything.`)
    stopServer()
    process.exit(1)
  }
  console.log(`  licence: ${JSON.stringify((await who.json()).data)}`)
  console.log(`  seed: ${await seed()}`)

  const chosen = viewportArg ? [VIEWPORTS[viewportArg]] : [VIEWPORTS.phone, VIEWPORTS.desk]
  if (chosen.some(v => !v)) {
    console.error(`unknown --viewport=${viewportArg} (use phone|desk)`)
    process.exit(2)
  }

  const results = []
  try {
    for (const vp of chosen) {
      console.log(`\n▸ ${vp.name} ${vp.width}×${vp.height}`)
      await runViewport(vp, results)
    }
  } finally {
    if (!KEEP) stopServer()
  }

  const width = Math.max(...results.map(r => r.stop.length), 12)
  console.log('\n  stop' + ' '.repeat(width - 2) + 'result')
  console.log('  ' + '─'.repeat(width + 12))
  for (const r of results) console.log(`  ${r.stop.padEnd(width + 2)}${r.pass ? 'PASS' : 'FAIL'}`)

  const notes = results.filter(r => r.allowed.length || r.net.length || r.probes.length)
  if (notes.length) {
    console.log('\n  notes (not failures)')
    for (const r of notes) {
      for (const a of r.allowed) console.log(`    ${r.stop}: ${a}`)
      for (const p of r.probes) console.log(`    ${r.stop}: ${p}`)
      if (r.net.length) console.log(`    ${r.stop}: HTTP ${r.net.join(', ')}`)
    }
  }

  const failed = results.filter(r => !r.pass)
  console.log(`\n  ${results.length - failed.length}/${results.length} stops passed. Screenshots: ${OUT_DIR}`)
  if (failed.length) {
    console.log('\n  FAILURES')
    for (const r of failed) for (const f of r.failures) console.log(`    ${r.stop}: ${f}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('\nwalkthrough crashed:', e)
  process.exit(1)
})
