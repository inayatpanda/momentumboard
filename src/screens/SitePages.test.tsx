import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { EnginePage, FaqPage, LedgerPage, siteRouteFor } from './SitePages'

// The public pages are the promise the app is measured against, so the sizing
// policy they describe has to be the policy the engine actually runs. They still
// described the pre-half-size world — "only A/B calls on full evidence carry
// size, everything else is watch-only" — which no longer matches a board that
// publishes half-size trades and, when nothing clears the gates, nearest misses.

const textOf = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ')

describe('the public pages describe the real sizing policy', () => {
  it('the engine page names all three tiers, and the nearest misses', () => {
    const t = textOf(render(<EnginePage />).container)
    expect(t).toContain('A or B on the full evidence contract is a full-size trade')
    expect(t).toMatch(/a C that clears the full contract, or an A\/B whose evidence is thin — the call still trades, at half size/)
    expect(t).toContain('with the gap it is missing named on the card')
    expect(t).toMatch(/Only when conviction and evidence are both short .* does the row publish watch-only/)
    expect(t).toContain('nearest misses')
    expect(t).toContain('No letter grade, no probability, no size')
    // the old claim, in either of its forms, is gone
    expect(t).not.toMatch(/C grades and thin-evidence calls publish as watch-only/)
    expect(t).not.toMatch(/stays watch-only, labelled as such/)
  })

  it('the ledger page explains an unqualified day the same way', () => {
    const t = textOf(render(<LedgerPage />).container)
    expect(t).toContain('at most three full-size trades per side')
    expect(t).toContain('trades at half size and says which half is missing')
    expect(t).toContain('the board names the nearest misses')
  })

  it('the FAQ answer on "no qualified trades" matches', () => {
    const t = textOf(render(<FaqPage />).container)
    expect(t).toContain('Why does it sometimes say "no qualified trades today"?')
    expect(t).toContain('Full size is reserved for A/B grades on full evidence')
    expect(t).toContain('trades at half size with the missing half named')
    expect(t).toContain('the nearest misses, labelled as misses')
    expect(t).not.toContain('Only A/B-grade calls on full evidence carry size')
  })
})

describe('siteRouteFor', () => {
  it('maps the public paths, defaulting to the front page', () => {
    expect(siteRouteFor('/engine')).toBe('engine')
    expect(siteRouteFor('/ledger')).toBe('ledger')
    expect(siteRouteFor('/faq')).toBe('faq')
    expect(siteRouteFor('/anything-else')).toBe('home')
  })
})
