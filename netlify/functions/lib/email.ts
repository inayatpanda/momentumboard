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

export function emailReadyHtml(reportHtml: string, browserUrl: string): string {
  const stripped = reportHtml.replace(/<script[\s\S]*?<\/script>/gi, '')
  const banner = `<div style="text-align:center;padding:10px 16px;font-family:-apple-system,system-ui,sans-serif;font-size:12px;color:#8b98a8;background:#0a0b0e">Reading in your mail app — <a href="${browserUrl}" style="color:#5aa9ff">open the full paper in your browser</a></div>`
  // inject the banner right after <body>, else prepend
  return /<body[^>]*>/i.test(stripped) ? stripped.replace(/<body[^>]*>/i, m => `${m}${banner}`) : banner + stripped
}

export async function sendReportEmail(env: EmailEnv, subject: string, html: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.REPORT_EMAIL_TO) return false
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.REPORT_EMAIL_FROM ?? 'The Street Signal <onboarding@resend.dev>',
        to: [env.REPORT_EMAIL_TO],
        subject,
        html,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}
