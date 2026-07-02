import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { sendTelegram } from './lib/telegram'

const MAX_BYTES = 800_000

const page = (status: number, body: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MomentumBoard — Morning Report</title></head>
<body style="margin:0;background:#0a0e12;color:#8b98a8;font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;text-align:center;padding:24px">
<div><h1 style="color:#e9eef4">No report yet</h1><p>The morning research routine publishes here on weekday mornings (~06:45 UK).</p></div></body></html>`

export interface StoredReport {
  html: string
  at: number
}

export async function routeReport(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { REPORT_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; URL?: string },
  store: AppStore,
  telegramSend: typeof sendTelegram = sendTelegram,
): Promise<Response> {
  if (method === 'GET') {
    const report = await store.read<StoredReport>('morning-report')
    return page(200, report?.html ?? PLACEHOLDER)
  }

  if (method === 'PUT') {
    if (!env.REPORT_TOKEN || headers.get('x-report-token') !== env.REPORT_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
    if (!bodyText || !bodyText.includes('<') || bodyText.length > MAX_BYTES) return json(400, { ok: false, error: 'invalid-html' })
    const at = Math.floor(Date.now() / 1000)
    const report: StoredReport = { html: bodyText, at }
    await store.write('morning-report', report)
    await store.write(`report:${new Date(at * 1000).toISOString().slice(0, 10)}`, report) // daily archive
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const link = `${env.URL ?? 'https://momentumboard-inayat.netlify.app'}/report`
      await telegramSend(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, `📰 Morning report is ready → ${link}`).catch(() => {})
    }
    return json(200, { ok: true, data: { at } })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeReport(
    req.method,
    req.headers,
    req.method === 'PUT' ? await req.text() : null,
    {
      REPORT_TOKEN: process.env.REPORT_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      URL: process.env.URL,
    },
    blobAppStore,
  )
