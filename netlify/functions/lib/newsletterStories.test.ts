// Story extraction from a Daily Upside issue's plain text. The fixture below
// is the real 2026-08-14 issue's shape: story headlines ride inline before
// their [url]; section labels are ALL-CAPS with the same pattern; the footer
// is a thicket of subscribe/author/fun links that must never become stories.

import { describe, expect, it } from 'vitest'
import { extractDailyUpsideStories } from './newsletterStories'

const ISSUE = `August 14, 2026

Good morning.

Elon Musk is defining egalitarianism drastically downward.

MARKETS [https://sprott.com/investment-strategies/?utm_source=the_daily_upside]

ARTIFICIAL INTELLIGENCE [https://www.thedailyupside.com/technology/artificial-intelligence/?hash63b] Anthropic's $6 Billion Deal Talks With Decart Show Focus on Cost Efficiency [https://www.thedailyupside.com/technology/artificial-intelligence/anthropic-eyes-cost-efficiency-with-potential-acquisition/?hash63b]

As Anthropic preps for its initial public offering, there's a math puzzle.

CONSUMER [https://www.thedailyupside.com/industries/consumer/?hash63b] Growth at Fast Food Joints Like Wendy's Looks Soggy Next to Casual-Dining Chains [https://www.thedailyupside.com/industries/consumer/fast-food-joints-like-wendys-look-soggy-next-to-casual-dining-chains/?hash63b] Photo via Jimin Kim

FINANCE [https://www.thedailyupside.com/finance/?hash63b] Ackman's Pershing Touts Value Investing Amid Bid to Stir Demand for Funds [https://www.thedailyupside.com/finance/markets/ackmans-pershing-plans-marketing-push/?hash63b] Photo via Lev Radin

Written by Sean Craig [https://www.thedailyupside.com/author/sean-craig/?hash63b]

Just for Fun In the bag. [https://www.thedailyupside.com/fun-upside/in-the-bag/?hash63b]

Our Other Newsletters [https://www.thedailyupside.com/subscribe/?utm_source=email]

Advisor Upside [https://www.thedailyupside.com/welcome-to-advisor-upside/?utm_source=email]`

describe('extractDailyUpsideStories', () => {
  it('finds the three real stories with their urls, and nothing from the footer thicket', () => {
    const stories = extractDailyUpsideStories(ISSUE)
    expect(stories.map(s => s.title)).toEqual([
      "Anthropic's $6 Billion Deal Talks With Decart Show Focus on Cost Efficiency",
      "Growth at Fast Food Joints Like Wendy's Looks Soggy Next to Casual-Dining Chains",
      "Ackman's Pershing Touts Value Investing Amid Bid to Stir Demand for Funds",
    ])
    expect(stories[0].url).toContain('/anthropic-eyes-cost-efficiency')
    // never the section label, the author page, the fun page, or the subscribe links
    expect(stories.some(s => /ARTIFICIAL INTELLIGENCE|author|fun-upside|subscribe|welcome-to/i.test(s.title + s.url))).toBe(false)
  })

  it('caps at 6 and returns [] on prose with no article links', () => {
    expect(extractDailyUpsideStories('Good morning. Nothing linked today.')).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => `Story Number ${i} With A Perfectly Reasonable Headline Length [https://www.thedailyupside.com/finance/markets/story-${i}/?x]`).join('\n\n')
    expect(extractDailyUpsideStories(many)).toHaveLength(6)
  })
})
