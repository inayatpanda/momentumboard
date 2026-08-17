// /api/newsletters — the Daily Upside door (owner 2026-08-17: "yes setup
// email"). The delivery mechanism is a Google Apps Script running inside the
// owner's own Gmail (hourly trigger): no forwarding rules, no DNS, no stored
// mail credentials — the Google account itself holds the access, and this
// endpoint holds a dedicated token. alert-check consumes `newsletter-inbox`
// on its next cycle and feeds the stories through the same triage as every
// other headline (source: 'The Daily Upside').
//
// The "WSB Insider" mail the owner also receives is Stock Market Loop's
// WordPress blast — already ingested and credibility-graded via RSS, so it is
// deliberately NOT on this allowlist.

import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'

export interface NewsletterMail {
  from: string
  subject: string
  text: string
  at: number
}

const ALLOWED_SENDERS = ['squad@thedailyupside.com']
const MAX_TEXT_CHARS = 60_000
const INBOX_KEY = 'newsletter-inbox'
const INBOX_CAP = 50

interface Env {
  NEWSLETTER_TOKEN?: string
}

export async function routeNewsletters(headers: Headers, method: string, bodyText: string | null, env: Env, store: AppStore): Promise<Response> {
  // an UNSET secret means the door does not exist — never an open door
  if (!env.NEWSLETTER_TOKEN || headers.get('x-newsletter-token') !== env.NEWSLETTER_TOKEN) {
    return new Response('unauthorized', { status: 401 })
  }
  if (method !== 'POST') return new Response('method-not-allowed', { status: 405 })

  interface SubmitBody {
    from?: string
    subject?: string
    text?: string
  }
  let body: SubmitBody | null = null
  try {
    body = bodyText ? (JSON.parse(bodyText) as SubmitBody) : null
  } catch {
    return new Response('bad-json', { status: 400 })
  }
  if (!body?.from || typeof body.subject !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return new Response('bad-body', { status: 400 })
  }
  const from = body.from.toLowerCase().trim()
  // 200, not 4xx: the posting script must treat "we don't want this sender"
  // as final, never as a retryable failure
  if (!ALLOWED_SENDERS.includes(from)) return new Response('sender-not-allowlisted', { status: 200 })

  const inbox = (await store.read<NewsletterMail[]>(INBOX_KEY)) ?? []
  if (inbox.some(m => m.from === from && m.subject === body.subject)) return new Response('already', { status: 200 })
  inbox.push({ from, subject: body.subject, text: body.text.slice(0, MAX_TEXT_CHARS), at: Math.floor(Date.now() / 1000) })
  await store.write(INBOX_KEY, inbox.slice(-INBOX_CAP))
  return new Response('stored', { status: 200 })
}

export default async (req: Request) =>
  routeNewsletters(req.headers, req.method, req.method === 'POST' ? await req.text() : null, { NEWSLETTER_TOKEN: process.env.NEWSLETTER_TOKEN }, blobAppStore)
