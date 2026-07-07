import { describe, expect, it, vi } from 'vitest'
import { emailReadyHtml, sendReportEmail } from './email'

describe('sendReportEmail', () => {
  it('no key or recipient → skipped without a network call', async () => {
    const fetchFn = vi.fn()
    expect(await sendReportEmail({}, 's', '<p>x</p>', fetchFn as unknown as typeof fetch)).toBe(false)
    expect(await sendReportEmail({ RESEND_API_KEY: 'k' }, 's', '<p>x</p>', fetchFn as unknown as typeof fetch)).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('posts to Resend with the recipient and subject; provider failure never throws', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    const sent = await sendReportEmail({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.com' }, 'Morning', '<p>hi</p>', ok as unknown as typeof fetch)
    expect(sent).toBe(true)
    const body = JSON.parse((ok.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.to).toEqual(['a@b.com'])
    expect(body.subject).toBe('Morning')
    const thrower = vi.fn(async () => { throw new Error('net') })
    expect(await sendReportEmail({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.com' }, 's', 'x', thrower as unknown as typeof fetch)).toBe(false)
  })
})

describe('emailReadyHtml', () => {
  it('strips scripts and injects the view-in-browser banner after <body>', () => {
    const out = emailReadyHtml('<html><body class="x"><h1>Paper</h1><script>alert(1)</script></body></html>', 'https://x/report')
    expect(out).not.toContain('<script>')
    expect(out).toContain('open the full paper')
    expect(out.indexOf('open the full paper')).toBeLessThan(out.indexOf('<h1>'))
  })
})
