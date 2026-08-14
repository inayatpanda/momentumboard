import type { Context } from '@netlify/functions'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { sendTelegram } from './lib/telegram'
import { scopedToken } from './lib/auth'
import { CANONICAL_SITE } from './lib/site'
import type { AppConfig } from '../../shared/config'

const MAX_BYTES = 800_000

const page = (status: number, body: string, downloadName?: string) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      // ?download=1 — the edition is one self-contained document (styles inline,
      // no external assets), so an attachment disposition turns the SAME bytes
      // into a share-anywhere .html file that opens offline in any browser
      ...(downloadName ? { 'content-disposition': `attachment; filename="${downloadName}"` } : {}),
    },
  })

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
  env: { REPORT_TOKEN?: string; REPORT_PUBLISH_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; URL?: string; FINNHUB_API_KEY?: string },
  store: AppStore,
  telegramSend: typeof sendTelegram = sendTelegram,
  url?: URL,
): Promise<Response> {
  // Fill each call block's status marker with where the price is NOW. Read-time,
  // not publish-time: the stored edition stays a clean record, and the PDF and
  // emailed copies (which use the stored HTML directly) carry no stale price.
  // FAIL-SOFT throughout — a quote outage must serve the paper, not break it.
  const withCallStatus = async (html: string, dateISO: string): Promise<string> => {
    try {
      const calls = await store.read<import('./lib/callStrip').EditionCall[]>(`report-calls:${dateISO}`)
      if (!calls?.length) return html
      const { cachedQuote } = await import('./lib/marketCache')
      const { fillCallStatus } = await import('./lib/callStrip')
      const prices = new Map<string, number>()
      await Promise.all(
        calls.map(async c => {
          const q = await cachedQuote(c.sym, env.FINNHUB_API_KEY ?? '').catch(() => null)
          if (q?.price) prices.set(c.sym, q.price)
        }),
      )
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
      return fillCallStatus(html, calls, sym => prices.get(sym) ?? null, { live: dateISO === today })
    } catch {
      return html
    }
  }

  if (method === 'GET') {
    const wantedDate = url?.searchParams.get('date')
    if (url?.searchParams.get('list') != null) {
      const index = (await store.read<string[]>('report-index')) ?? []
      return json(200, { ok: true, data: index.slice().reverse() })
    }
    if (url?.searchParams.get('bulletins') != null) {
      const index = (await store.read<{ date: string; kind: string }[]>('bulletin-index')) ?? []
      return json(200, { ok: true, data: index.slice().reverse() })
    }
    const wantedBulletin = url?.searchParams.get('bulletin') // "<date>:<kind>"
    if (wantedBulletin) {
      const [bDate, bKind] = wantedBulletin.split(':')
      const day = (await store.read<{ kind: string; html: string }[]>(`bulletins:${bDate}`)) ?? []
      const hit = day.find(b => b.kind === bKind)
      return page(hit ? 200 : 404, hit?.html ?? PLACEHOLDER)
    }
    const asFile = url?.searchParams.get('download') != null
    // ?format=json (CX-19): the SAME edition bytes in a JSON envelope, so the
    // app can render the paper inline (sandboxed srcDoc) — the route's
    // X-Frame-Options stays DENY, and srcDoc is not a navigation. Read-only,
    // additive: HTML/download modes and the publish path are untouched.
    const asJson = url?.searchParams.get('format') === 'json'
    if (wantedDate) {
      const archived = await store.read<StoredReport>(`report:${wantedDate}`)
      if (asJson) {
        if (!archived) return json(404, { ok: false, error: 'no edition for that date' })
        return json(200, { ok: true, data: { date: wantedDate, at: archived.at, html: await withCallStatus(archived.html, wantedDate) } })
      }
      // a DOWNLOAD is a snapshot to keep — never bake a live price into it
      const body = archived && !asFile ? await withCallStatus(archived.html, wantedDate) : archived?.html
      return page(archived ? 200 : 404, body ?? PLACEHOLDER, asFile && archived ? `StreetSignal-${wantedDate}.html` : undefined)
    }
    const report = await store.read<StoredReport>('morning-report')
    const latestDate = report ? new Date(report.at * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) : ''
    if (asJson) {
      if (!report) return json(404, { ok: false, error: 'no edition yet' })
      return json(200, { ok: true, data: { date: latestDate, at: report.at, html: await withCallStatus(report.html, latestDate) } })
    }
    const latestBody = report && !asFile ? await withCallStatus(report.html, latestDate) : report?.html
    return page(200, latestBody ?? PLACEHOLDER, asFile && report ? `StreetSignal-${latestDate}.html` : undefined)
  }

  if (method === 'PUT') {
    // audit H-1: prefer a dedicated REPORT_PUBLISH_TOKEN; fall back to
    // REPORT_TOKEN until the owner sets it everywhere the composer runs.
    const publishTok = scopedToken(env.REPORT_PUBLISH_TOKEN, env.REPORT_TOKEN)
    if (!publishTok || headers.get('x-report-token') !== publishTok) return json(401, { ok: false, error: 'unauthorized' })

    // JSON body = the day's structured picks (published alongside the HTML article)
    if ((headers.get('content-type') ?? '').includes('application/json')) {
      const { validatePicks, newlyPersistent } = await import('./lib/picks')
      let picks
      try {
        picks = validatePicks(bodyText ? JSON.parse(bodyText) : null)
      } catch {
        picks = null
      }
      if (!picks) return json(400, { ok: false, error: 'invalid-picks' })
      // capture the price at recommendation time — the outcome-scoring baseline
      const { cachedQuote } = await import('./lib/marketCache')
      await Promise.all(
        picks.picks.map(async p => {
          const q = await cachedQuote(p.ticker, env.FINNHUB_API_KEY ?? '')
          if (q) p.priceAtPick = q.price
        }),
      )
      // Stamp when the day was actually stored, so incremental consumers (the Helm
      // mirror) can tell a freshly published day from an old one without guessing
      // from `date`. Set after validation — validatePicks rebuilds the object.
      picks.at = Math.floor(Date.now() / 1000)
      const history = ((await store.read<(typeof picks)[]>('report-picks')) ?? []).filter(h => h.date !== picks.date)
      history.push(picks)
      history.sort((a, b) => a.date.localeCompare(b.date))
      await store.write('report-picks', history.slice(-60))
      const monthKey = `report-picks:${picks.date.slice(0, 7)}`
      const archive = ((await store.read<unknown[]>(monthKey)) ?? []).filter(h => (h as { date: string }).date !== picks.date)
      archive.push(picks)
      await store.write(monthKey, archive)
      const fresh = newlyPersistent(history.slice(-60))
      const lines: string[] = []
      for (const p of picks.picks.filter(p => p.strength === 'strong')) {
        lines.push(`🎯 STRONG call: ${p.ticker} (${p.side})${p.reasons?.length ? ` — ${p.reasons[0]}` : ''}. Full reasoning in the report.`)
      }
      lines.push(...fresh.map(p => `📌 ${p.ticker} (${p.side}) is now a PERSISTENT pick — ${p.streak >= 3 ? `${p.streak} reports running` : `${p.appearances} of the last 7 reports`}. Independent daily analyses keep converging on it.`))
      if (lines.length && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, lines.join('\n')).catch(() => {})
      }
      return json(200, { ok: true, data: { stored: picks.date, newlyPersistent: fresh } })
    }

    if (!bodyText || !bodyText.includes('<') || bodyText.length > MAX_BYTES) return json(400, { ok: false, error: 'invalid-html' })
    // The compose pipe now wraps the paper in a JSON envelope { html, print } so
    // the PDF can be TYPESET from structured data (heat map, charts, ruled tables)
    // instead of re-parsed from the HTML. Raw-HTML bodies (older callers, tests)
    // still work — unwrap fail-soft, and only when the body actually parses as an
    // envelope carrying an html string.
    let html = bodyText
    let print: import('./lib/reportPdf').ReportPrintData | undefined
    if (bodyText.trimStart().startsWith('{')) {
      try {
        const env = JSON.parse(bodyText) as { html?: unknown; print?: unknown }
        if (env && typeof env.html === 'string') {
          html = env.html
          print = (env.print ?? undefined) as import('./lib/reportPdf').ReportPrintData | undefined
        }
      } catch {
        /* not an envelope — bodyText is the HTML itself */
      }
    }
    const at = Math.floor(Date.now() / 1000)
    const report: StoredReport = { html, at }
    const dateKey = new Date(at * 1000).toISOString().slice(0, 10)
    // same-day re-publish? Gmail threads identical subjects and hides "repeated"
    // sections behind ⋯ trims — a unique suffix keeps every edition whole.
    const prior = await store.read<StoredReport>('morning-report').catch(() => null)
    const republished = !!prior && new Date(prior.at * 1000).toISOString().slice(0, 10) === dateKey
    await store.write('morning-report', report)
    await store.write(`report:${dateKey}`, report) // daily archive
    const index = (await store.read<string[]>('report-index')) ?? []
    if (!index.includes(dateKey)) {
      index.push(dateKey)
      await store.write('report-index', index.slice(-90))
    }
    const link = `${CANONICAL_SITE}/report`
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, `📰 Morning report is ready → ${link}`).catch(() => {})
    }
    // the same paper lands in the inbox — fail-soft, skipped when no key is set
    try {
      const { emailReadyHtml, sendReportEmail, recipientsForEdition } = await import('./lib/email')
      const cfg = await store.read<AppConfig>('config').catch(() => null)
      const dateLabel = new Date(at * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })
      // A print-edition PDF rides along with the email, composed on-box from the
      // finished HTML. FAIL-SOFT: a PDF error must never block or delay the send —
      // on failure the email still goes, just without the attachment.
      let attachments: { filename: string; content: string }[] | undefined
      if (process.env.RESEND_API_KEY) {
        try {
          const { composeReportPdf } = await import('./lib/reportPdf')
          const pdf = await composeReportPdf({ html, dateLabel, print })
          if (pdf?.length) attachments = [{ filename: `StreetSignal-${dateKey}.pdf`, content: Buffer.from(pdf).toString('base64') }]
        } catch {
          /* print edition is best-effort — send without it */
        }
      }
      await sendReportEmail(
        { RESEND_API_KEY: process.env.RESEND_API_KEY, REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO, REPORT_EMAIL_FROM: process.env.REPORT_EMAIL_FROM },
        `The Street Signal — ${dateLabel}${republished ? ` · updated ${new Date(at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}` : ''}`,
        emailReadyHtml(html, `${link}?date=${dateKey}`),
        fetch,
        attachments,
        recipientsForEdition('morning', cfg?.reportRecipients),
      )
    } catch {
      /* email is best-effort */
    }
    try {
      const { sendPushAll } = await import('./lib/pushSend')
      await sendPushAll(store, { VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY }, { title: 'Morning report is ready', body: 'Tap to read today’s analysis', url: '/report' })
    } catch {
      /* push is best-effort */
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
      REPORT_PUBLISH_TOKEN: process.env.REPORT_PUBLISH_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      URL: process.env.URL,
      FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
    },
    blobAppStore,
    sendTelegram,
    new URL(req.url),
  )
