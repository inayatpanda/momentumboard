// /api/newsletters — the Daily Upside door. A Google Apps Script inside the
// owner's own Gmail posts each new issue here (no forwarding, no DNS — the
// account IS the credential holder); alert-check turns stored issues into
// news-desk stories on its next cycle. Same door rules as video-transcripts:
// a dedicated token, an unset secret is a closed door, and a sender
// allowlist because an inbound-text endpoint is a write surface.

import { beforeEach, describe, expect, it } from 'vitest'
import { memoryStore } from './lib/store'
import type { AppStore } from './lib/storeProvider'
import { routeNewsletters, type NewsletterMail } from './newsletters.mts'

const ENV = { NEWSLETTER_TOKEN: 'script-secret' }
const auth = new Headers({ 'x-newsletter-token': 'script-secret' })

let store: AppStore
beforeEach(() => {
  store = memoryStore()
})

const post = (body: unknown, headers = auth, env: Record<string, string | undefined> = ENV) =>
  routeNewsletters(headers, 'POST', JSON.stringify(body), env, store)

const issue = { from: 'squad@thedailyupside.com', subject: 'The Cheesecake Shot', text: 'Good morning. '.repeat(30) }

describe('auth', () => {
  it('401s a wrong token, a missing token, and an unset server secret', async () => {
    expect((await post(issue, new Headers({ 'x-newsletter-token': 'wrong' }))).status).toBe(401)
    expect((await post(issue, new Headers())).status).toBe(401)
    expect((await post(issue, auth, {})).status).toBe(401)
  })
})

describe('POST', () => {
  it('stores an allowlisted issue and stamps it', async () => {
    const res = await post(issue)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('stored')
    const inbox = (await store.read<NewsletterMail[]>('newsletter-inbox'))!
    expect(inbox).toHaveLength(1)
    expect(inbox[0].subject).toBe('The Cheesecake Shot')
    expect(inbox[0].at).toBeGreaterThan(1_700_000_000)
  })

  it('dedupes by from+subject — a re-post answers already and stores once', async () => {
    await post(issue)
    const res = await post(issue)
    expect(await res.text()).toBe('already')
    expect((await store.read<NewsletterMail[]>('newsletter-inbox'))!).toHaveLength(1)
  })

  it('rejects a sender off the allowlist — this door is not a mailbox', async () => {
    const res = await post({ ...issue, from: 'donotreply@wordpress.com' })
    expect(res.status).toBe(200) // acknowledged so the script does not retry forever
    expect(await res.text()).toBe('sender-not-allowlisted')
    expect(await store.read('newsletter-inbox')).toBeNull()
  })

  it('rejects malformed bodies and over-long text', async () => {
    expect((await post(null)).status).toBe(400)
    expect((await post({ from: issue.from })).status).toBe(400)
    const res = await post({ ...issue, text: 'x'.repeat(120_000) })
    expect(res.status).toBe(200) // stored, truncated
    const inbox = (await store.read<NewsletterMail[]>('newsletter-inbox'))!
    expect(inbox[0].text.length).toBeLessThanOrEqual(60_000)
  })

  it('rolls at 50', async () => {
    for (let i = 0; i < 53; i++) await post({ ...issue, subject: `Issue ${i}` })
    expect((await store.read<NewsletterMail[]>('newsletter-inbox'))!).toHaveLength(50)
  })
})
