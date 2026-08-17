// Deterministic story extraction from a Daily Upside issue's plain text.
// Shape observed live (2026-08-14 issue): each story headline sits inline
// immediately before its bracketed article url. Section labels share the
// pattern but are ALL-CAPS and link to category pages (shallow paths); the
// footer links (author/subscribe/fun/welcome) are excluded by path.

export interface NewsletterStory {
  title: string
  url: string
}

const MAX_STORIES = 6
const JUNK_PATH = /\/(author|fun-upside|subscribe|welcome-to|about|advertise)/i

/** An article url is a DEEP thedailyupside path: /section/subsection/slug. */
const linkPattern = /([^\[\]\n]{25,160})\s+\[(https:\/\/www\.thedailyupside\.com\/[a-z-]+\/[a-z-]+\/[a-z0-9-]+\/?[^\]]*)\]/g

export function extractDailyUpsideStories(text: string): NewsletterStory[] {
  const out: NewsletterStory[] = []
  for (const m of text.matchAll(linkPattern)) {
    const title = m[1].trim().replace(/^.*\]\s*/, '') // drop any preceding [url] remnant
    const url = m[2]
    if (JUNK_PATH.test(url)) continue
    if (title.length < 25 || title.length > 140) continue
    if (title === title.toUpperCase()) continue // section labels shout; headlines don't
    if (out.some(s => s.url === url)) continue
    out.push({ title, url })
    if (out.length >= MAX_STORIES) break
  }
  return out
}
