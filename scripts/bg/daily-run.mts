// The daily engine+paper run, GitHub Actions edition. Netlify's free plan has
// no background functions, so the two long jobs (predict-background, the
// report composer) execute HERE on a cron runner — same code, same Blobs store
// (lib/store.ts + lib/cache.ts pick up NETLIFY_SITE_ID/NETLIFY_AUTH_TOKEN and
// talk to the store over the API). Mirrors report-kick.mts's routing exactly:
// weekday → engine (which the orchestrator follows with the composer);
// weekend/US-market holiday → composer only (the weekend/holiday edition).
//
// GUARDED for a graceful cutover: scheduled at 05:35 UTC — 15 min after
// Netlify's own 05:20 kick — so while the paid plan still runs background
// functions, this sees today's board/paper already exist and does nothing.
// The day the plan downgrades, the Netlify path 404s and this takes over.

import { isUsMarketHoliday } from '../../shared/usMarketHolidays'
import { blobAppStore } from '../../netlify/functions/lib/store'

const requireEnv = (names: string[]) => {
  const missing = names.filter(n => !process.env[n])
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`)
}

const adminReq = () =>
  new Request('https://actions.local/', { method: 'POST', headers: { 'x-app-token': process.env.APP_TOKEN ?? '' } })

const londonDate = (nowSec: number) => new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

const run = async () => {
  requireEnv(['NETLIFY_SITE_ID', 'NETLIFY_AUTH_TOKEN', 'APP_TOKEN', 'FINNHUB_API_KEY'])
  const nowSec = Math.floor(Date.now() / 1000)
  const today = londonDate(nowSec)
  // audit M-2: a fixed-UTC cron publishes an hour early in GMT/winter. Hold the
  // run until it is at least 06:00 in London so the edition lands near the stated
  // ~06:45 UK time year-round; the redundant later cron shots then compose. A
  // manual workflow_dispatch (FORCE_RUN=1) bypasses the floor.
  const londonHour = new Date(new Date(nowSec * 1000).toLocaleString('en-US', { timeZone: 'Europe/London' })).getHours()
  if (process.env.FORCE_RUN !== '1' && londonHour < 6) {
    console.log(`daily-run: ${today} — London ${londonHour}:xx is too early, deferring to the next cron slot`)
    return
  }
  const utcDay = new Date().getUTCDay()
  const isoDate = new Date().toISOString().slice(0, 10)
  const tradingDay = utcDay !== 0 && utcDay !== 6 && !isUsMarketHoliday(isoDate)
  console.log(`daily-run: ${today} (trading day: ${tradingDay})`)

  if (tradingDay) {
    const board = await blobAppStore.read<{ date: string }>('engine-board')
    if (board?.date === today) {
      console.log('engine: already ran today (board is fresh) — skipping')
    } else {
      console.log('engine: running predict-background in-process…')
      process.env.SKIP_COMPOSE_CHAIN = '1' // the orchestrator runs the composer itself below
      const { default: predict } = await import('../../netlify/functions/predict-background.mts')
      const res = await predict(adminReq())
      console.log(`engine: ${res.status} ${await res.text()}`)
      // engine failure does NOT stop the paper — same contract as the old chain
    }
  }

  // Score yesterday's calls BEFORE composing, so the paper (and Helm) carry a
  // current scorecard. Nothing used to compute this on a schedule — it was built
  // lazily when a reader opened the app, so the record was usually absent.
  try {
    const { default: market } = await import('../../netlify/functions/market-data.mts')
    const res = await market(new Request('https://actions.local/api/market?type=pick-stats&fresh=1', { headers: { 'x-app-token': process.env.APP_TOKEN ?? '' } }), {} as never)
    console.log(`scorecard: ${res.status}`)
  } catch (e) {
    console.error('scorecard: FAILED (paper still publishes)', e) // never block the edition
  }

  const paper = await blobAppStore.read<unknown>(`report:${today}`)
  if (paper) {
    console.log('paper: already composed today — skipping')
  } else {
    console.log('paper: running report-compose-background in-process…')
    const { default: compose } = await import('../../netlify/functions/report-compose-background.mts')
    const res = await compose(adminReq())
    const body = await res.text()
    console.log(`paper: ${res.status} ${body}`)
    if (res.status >= 400) {
      // Provider-quota mornings (Gemini prepay depleted + Groq tokens-per-day
      // spent) fail every one of the three cron shots identically, mailing
      // three "Run failed" alerts for ONE condition (2026-08-04). Quota does
      // not come back between shots on its own, so only the FIRST quota
      // failure of the day is loud; later shots still retry — a mid-morning
      // top-up composes the paper — but exit quietly if quota is still gone.
      // Any non-quota failure stays loud on every shot.
      const quotaShaped = /\b429\b|rate[_ ]?limit|quota|depleted|credit/i.test(body)
      if (quotaShaped) {
        const alertKey = `report-quota-alerted:${today}`
        if (await blobAppStore.read<unknown>(alertKey)) {
          console.log('paper: providers still quota-exhausted — already alerted once today, exiting quietly (next shot retries)')
          return
        }
        await blobAppStore.write(alertKey, { at: nowSec, body: body.slice(0, 500) })
      }
      process.exit(1)
    }
  }
  console.log('daily-run: done')
}

run().catch(e => {
  console.error('daily-run failed:', e)
  process.exit(1)
})
