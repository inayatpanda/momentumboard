import { appStore as blobAppStore } from './lib/storeProvider'

// THE WEEKLY SNAPSHOT: the engine's entire track record — predictions,
// calibration, weights, scorecard, the paper book — lives in one blob store.
// Every Sunday this mails the lot to the reader as a JSON attachment, so the
// accountability record survives anything that happens to the hosting.

export default async (req: Request) => {
  // Emails the full backup — an open URL is a spam vector. Reject non-scheduler /
  // non-admin requests, AND (since `next_run` is a guessable string, audit C-1)
  // rate-BOUND whatever passes to ~once/day (20h window). Admin token bypasses.
  const body = await req.text().catch(() => '')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('ledger-snapshot', 72_000, admin))) return new Response('throttled', { status: 429 })

  const nowSec = Math.floor(Date.now() / 1000)
  const dateISO = new Date(nowSec * 1000).toISOString().slice(0, 10)
  const read = <T,>(key: string) => blobAppStore.read<T>(key).catch(() => null)

  const predIndex = ((await read<string[]>('predictions-index')) ?? []).slice(-60)
  const predictions: Record<string, unknown> = {}
  for (const date of predIndex) predictions[date] = await read(`predictions:${date}`)

  const snapshot = {
    takenAt: dateISO,
    calibration: await read('engine-calibration'),
    weights: await read('engine-weights'),
    scorecard: await read('engine-scorecard'),
    paperBook: await read('paper-book'),
    paperMonths: await read('paper-months'),
    riskState: await read('risk-state'),
    // the crypto partition's two sibling blobs (1c Phase B) — its whole
    // learning record; leaving them out made the cohort invisible to the one
    // consumer built to survive the hosting
    cryptoCalibration: await read('crypto-calibration'),
    cryptoRisk: await read('crypto-risk'),
    roster: await read('engine-roster'),
    socialHistory: await read('social-history'), // restoring without it costs a fresh 7-day hype-cluster warm-up
    reportPicks: await read('report-picks'),
    reportIndex: await read('report-index'),
    bulletinIndex: await read('bulletin-index'),
    channelCredibility: await read('channel-credibility'),
    predictionsIndex: predIndex,
    predictions,
  }

  const json = JSON.stringify(snapshot)
  const { sendReportEmail } = await import('./lib/email')
  const sent = await sendReportEmail(
    { RESEND_API_KEY: process.env.RESEND_API_KEY, REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO, REPORT_EMAIL_FROM: process.env.REPORT_EMAIL_FROM },
    `StreetSignal ledger snapshot — ${dateISO}`,
    `<div style="font-family:-apple-system,system-ui,sans-serif;padding:20px;background:#0a0b0e;color:#eceff4">
<div style="font-family:Georgia,serif;font-size:20px">StreetSignal</div>
<p style="color:#98a2b3">Weekly track-record snapshot, ${dateISO}. The attachment holds the engine's full state — ${predIndex.length} prediction dates, calibration, weights, scorecard and the paper book (${Math.round(json.length / 1024)} KB). Keep the email; it IS the backup.</p></div>`,
    fetch,
    [{ filename: `streetsignal-ledger-${dateISO}.json`, content: Buffer.from(json).toString('base64') }],
  )

  const runlog = (await blobAppStore.read<unknown[]>('runlog').catch(() => null)) ?? []
  runlog.push({ at: nowSec, kind: 'ledger-snapshot', sent, bytes: json.length })
  await blobAppStore.write('runlog', runlog.slice(-200))
  return new Response(JSON.stringify({ ok: sent, bytes: json.length }), { headers: { 'content-type': 'application/json' } })
}

// Sunday 08:00 UTC — quiet time, after Saturday's weekend edition
export const config = { schedule: '0 8 * * 0' }
