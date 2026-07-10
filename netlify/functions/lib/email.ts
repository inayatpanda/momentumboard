// Morning-paper email delivery via Resend. Fail-soft like Telegram and push:
// no key configured → quietly skipped, a provider outage never blocks the
// publish. Gmail strips <script> and clips very large messages, so scripts are
// removed and a view-in-browser banner rides on top — the clipped tail always
// has an escape hatch.

export interface EmailEnv {
  RESEND_API_KEY?: string
  REPORT_EMAIL_TO?: string
  REPORT_EMAIL_FROM?: string
}

/** Parse REPORT_EMAIL_TO into a clean recipient list. Accepts a single address
 * or a delimited list (commas / semicolons / whitespace / newlines). Trims,
 * lowercases, keeps only plausible addresses, dedupes (first-seen order).
 * Returns [] for empty/undefined so callers can treat "no recipients" as
 * "email unconfigured". */
export function parseRecipients(raw: string | undefined | null): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,;\s]+/)) {
    const addr = part.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || seen.has(addr)) continue
    seen.add(addr)
    out.push(addr)
  }
  return out
}

export function emailReadyHtml(reportHtml: string, browserUrl: string): string {
  const stripped = reportHtml.replace(/<script[\s\S]*?<\/script>/gi, '')
  // Mail clients trim, clip and strip (Gmail's ⋯ is its own chrome — no email can
  // restyle it). The honest counter: an unmissable bar top AND bottom that opens
  // the full edition in the browser, where nothing is ever hidden.
  const bar = (label: string) =>
    `<div style="text-align:center;padding:8px 16px 14px;font-family:-apple-system,system-ui,sans-serif;background:#0a0b0e">` +
    `<a href="${browserUrl}" style="display:inline-block;padding:10px 22px;border:1px solid #5aa9ff;border-radius:8px;color:#5aa9ff;font-size:13px;font-weight:600;text-decoration:none">${label}</a>` +
    `</div>`
  const top = bar('Open the full paper in your browser →')
  const bottom =
    `<div style="text-align:center;padding:14px 16px 4px;font-family:-apple-system,system-ui,sans-serif;font-size:12px;color:#8b98a8;background:#0a0b0e">Sections collapsed or cut off by your mail app?</div>` +
    bar('Read the complete edition →')
  const withTop = /<body[^>]*>/i.test(stripped) ? stripped.replace(/<body[^>]*>/i, m => `${m}${top}`) : top + stripped
  return /<\/body>/i.test(withTop) ? withTop.replace(/<\/body>/i, `${bottom}</body>`) : withTop + bottom
}

export async function sendReportEmail(
  env: EmailEnv,
  subject: string,
  html: string,
  fetchFn: typeof fetch = fetch,
  attachments?: { filename: string; content: string }[], // content = base64
  extraRecipients?: string[], // admin-managed recipients (config.reportRecipients), unioned with env.REPORT_EMAIL_TO
): Promise<boolean> {
  const to = [...new Set([...parseRecipients(env.REPORT_EMAIL_TO), ...parseRecipients(extraRecipients?.join(','))])]
  if (!env.RESEND_API_KEY || to.length === 0) return false
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.REPORT_EMAIL_FROM ?? 'The Street Signal <onboarding@resend.dev>',
        to,
        subject,
        html,
        ...(attachments?.length ? { attachments } : {}),
      }),
    })
    return res.ok
  } catch {
    return false
  }
}
