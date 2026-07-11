import { describe, expect, it, vi } from 'vitest'
import { emailFitHtml, emailReadyHtml, parseRecipients, sendReportEmail } from './email'

describe('parseRecipients', () => {
  it('empty / undefined / null → []', () => {
    expect(parseRecipients(undefined)).toEqual([])
    expect(parseRecipients(null)).toEqual([])
    expect(parseRecipients('')).toEqual([])
    expect(parseRecipients('   ')).toEqual([])
  })
  it('a single address stays a one-element list, lowercased', () => {
    expect(parseRecipients('A@B.com')).toEqual(['a@b.com'])
  })
  it('splits a comma list', () => {
    expect(parseRecipients('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })
  it('handles a semicolon + space + newline mix', () => {
    expect(parseRecipients('a@x.com; b@y.com\nc@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
  })
  it('filters out junk that is not an address', () => {
    expect(parseRecipients('a@x.com, nope, @bad, b@no-tld, c@z.com')).toEqual(['a@x.com', 'c@z.com'])
  })
  it('dedupes, preserving first-seen order', () => {
    expect(parseRecipients('a@x.com, A@X.com, b@y.com, a@x.com')).toEqual(['a@x.com', 'b@y.com'])
  })
})

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
  it('a multi-address env var yields a multi-element to list', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    const sent = await sendReportEmail({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@x.com, b@y.com' }, 's', 'x', ok as unknown as typeof fetch)
    expect(sent).toBe(true)
    const body = JSON.parse((ok.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.to).toEqual(['a@x.com', 'b@y.com'])
  })
  it('a configured key but no valid recipient → skipped without a network call', async () => {
    const fetchFn = vi.fn()
    expect(await sendReportEmail({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'not-an-email' }, 's', 'x', fetchFn as unknown as typeof fetch)).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('emailReadyHtml', () => {
  it('strips scripts and injects open-in-browser bars top AND bottom', () => {
    const out = emailReadyHtml('<html><body class="x"><h1>Paper</h1><script>alert(1)</script></body></html>', 'https://x/report')
    expect(out).not.toContain('<script>')
    expect(out).toContain('Open the full paper in your browser')
    expect(out.indexOf('Open the full paper')).toBeLessThan(out.indexOf('<h1>')) // top bar before content
    expect(out).toContain('Sections collapsed or cut off by your mail app?')
    expect(out.indexOf('Read the complete edition')).toBeGreaterThan(out.indexOf('<h1>')) // bottom bar after content
    expect(out.match(/https:\/\/x\/report/g)!.length).toBeGreaterThanOrEqual(2) // both bars link out
  })
})

describe('emailFitHtml — nothing in an email may be wider than the phone', () => {
  it('neutralises inline hard min-widths but leaves media-query breakpoints alone', () => {
    const html = '<html><head><style>@media(min-width:760px){.cols{column-count:2}}</style></head>' +
      '<body><div style="overflow-x:auto"><table style="width:100%;min-width:520px"><tr><td>x</td></tr></table></div></body></html>'
    const out = emailFitHtml(html)
    expect(out).not.toContain('min-width:520px') // the whole-email panning culprit
    expect(out).toContain('min-width:0')
    expect(out).toContain('@media(min-width:760px)') // breakpoint untouched
  })
  it('injects the fit overrides into <head> (fixed tables, wrapping cells)', () => {
    const out = emailFitHtml('<html><head><title>t</title></head><body></body></html>')
    expect(out).toContain('data-email-fit')
    expect(out).toContain('table-layout:fixed!important')
    expect(out.indexOf('data-email-fit')).toBeLessThan(out.indexOf('</head>'))
  })
  it('headless fragments get the overrides prepended instead', () => {
    const out = emailFitHtml('<table style="min-width:640px"><tr><td>x</td></tr></table>')
    expect(out.startsWith('<style data-email-fit')).toBe(true)
    expect(out).not.toContain('640px')
  })
  it('sendReportEmail applies the fit pass to every outgoing email', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    await sendReportEmail({ RESEND_API_KEY: 'k', REPORT_EMAIL_TO: 'a@b.com' }, 's', '<html><head></head><body><table style="min-width:520px"></table></body></html>', ok as unknown as typeof fetch)
    const body = JSON.parse((ok.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.html).toContain('data-email-fit')
    expect(body.html).not.toContain('min-width:520px')
  })
})
