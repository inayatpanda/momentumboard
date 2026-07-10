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
  const banner = `<div style="text-align:center;padding:10px 16px;font-family:-apple-system,system-ui,sans-serif;font-size:12px;color:#8b98a8;background:#0a0b0e">Reading in your mail app — <a href="${browserUrl}" style="color:#5aa9ff">open the full paper in your browser</a></div>`
  // inject the banner right after <body>, else prepend
  return /<body[^>]*>/i.test(stripped) ? stripped.replace(/<body[^>]*>/i, m => `${m}${banner}`) : banner + stripped
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
