// The v2 shell (plan Task 10 + CX-3/9/11): wouter under /app, exactly the
// ratified five nav labels, deep-linkable stock pages, and an unknown-route
// catch-all that lands on Today.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { memoryLocation } from 'wouter/memory-location'
import AppShell from './AppShell'

// non-static: the catch-all NAVIGATES to /app/, a static hook would pin it
const at = (path: string) => memoryLocation({ path: `/app${path}` }).hook

describe('AppShell', () => {
  it('opens the Research desk on the Today route at /app/', async () => {
    render(<AppShell locationHook={at('/')} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Research desk' })).toBeInTheDocument()
  })

  // THE PHONE BAR IS THE RATIFIED FIVE, and owner iteration 2 did not touch it:
  // the three pages promoted onto the desktop rail carry `.rail-only`, which is
  // `display: none` until 1024px. jsdom applies no stylesheet, so "what the
  // phone shows" is asserted as "the entries that are NOT rail-only" — the same
  // predicate the CSS reads, and the only form that is honest here (a
  // visibility assertion in jsdom would pass for a reason unrelated to the
  // media query).
  it('shows exactly the five ratified nav labels, in order — Board is routable but unlabelled', () => {
    render(<AppShell locationHook={at('/')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const labels = [...nav.querySelectorAll('.v2-tab:not(.rail-only) .v2-tab-label')].map(el => el.textContent?.trim())
    expect(labels).toEqual(['Today', 'Stocks', 'Intel', 'Track record', 'More'])
  })

  // …and the RAIL shows ten: the ratified five plus five promoted out of
  // More — Analytics rides the rail until it earns a phone tab of its own. Owner 2026-08-17 recut the set three times in one day: Gates &
  // learning DEMOTED ("present twice, outside and inside More"), in its slot a
  // fresh tab for the daily edition ("instead of Gates and learning… a new
  // fresh tab, move… just the Today paper"), and then The street ("all in a
  // new page/tab altogether") FIRST of the promoted — the most-visited of them.
  it('carries five rail-only entries — Analytics, The street, Research, Calendar, The paper; Gates demoted', () => {
    render(<AppShell locationHook={at('/')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const labels = [...nav.querySelectorAll('.v2-tab-label')].map(el => el.textContent?.trim())
    expect(labels).toEqual(['Today', 'Stocks', 'Intel', 'Track record', 'Analytics', 'The street', 'Research', 'Calendar', 'The paper', 'More'])
    const railOnly = [...nav.querySelectorAll('.v2-tab.rail-only .v2-tab-label')].map(el => el.textContent?.trim())
    expect(railOnly).toEqual(['Analytics', 'The street', 'Research', 'Calendar', 'The paper'])
  })

  it('the promoted entries link to their real routes', () => {
    render(<AppShell locationHook={at('/')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const hrefs = [...nav.querySelectorAll('.v2-tab.rail-only')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['/app/analytics', '/app/more/street', '/app/more/research', '/app/more/calendar', '/app/more/paper'])
  })

  it('lights The street’s own rail row inside the page, with a glyph of its own', () => {
    render(<AppShell locationHook={at('/more/street')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).toHaveClass('on-promoted')
    const street = [...nav.querySelectorAll('.v2-tab')].find(a => a.textContent?.includes('The street'))!
    expect(street).toHaveClass('on')
    expect(street).toHaveAttribute('aria-current', 'page')
    // every rail glyph is distinct — a shared one makes two rows look like one
    const glyphs = [...nav.querySelectorAll('.v2-tab-icon')].map(el => el.querySelector('path')?.getAttribute('d'))
    expect(glyphs.every(Boolean)).toBe(true)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('a promoted page lights its own row, and marks the nav so the rail can dim the More parent', () => {
    render(<AppShell locationHook={at('/more/research')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).toHaveClass('on-promoted')
    const research = [...nav.querySelectorAll('.v2-tab')].find(a => a.textContent?.includes('Research'))!
    expect(research).toHaveClass('on')
    expect(research).toHaveAttribute('aria-current', 'page')
    // the phone's More tab still lights inside these pages — that is the bar
    // that was ratified, and only CSS (≥1024px) quiets it on the rail
    const more = [...nav.querySelectorAll('.v2-tab:not(.rail-only)')].find(a => a.textContent?.includes('More'))!
    expect(more).toHaveClass('on')
  })

  it('the demoted Gates page routes fine but lights only More — no rail row of its own', async () => {
    render(<AppShell locationHook={at('/more/gates')} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).not.toHaveClass('on-promoted')
    expect([...nav.querySelectorAll('.v2-tab-label')].some(el => el.textContent?.includes('Gates'))).toBe(false)
    const more = [...nav.querySelectorAll('.v2-tab')].find(a => a.textContent?.includes('More'))!
    expect(more).toHaveClass('on')
  })

  it('deep-links a stock page with its symbol', async () => {
    render(<AppShell locationHook={at('/stock/NVDA')} />)
    // 5s: the lazy StockPage chunk resolves in ~300ms alone but can exceed
    // RTL's 1s default under full-suite parallel load (verified flake)
    expect(await screen.findByRole('heading', { name: 'NVDA' }, { timeout: 5000 })).toBeInTheDocument()
  })

  it('routes /board even though it has no tab', async () => {
    render(<AppShell locationHook={at('/board')} />)
    expect(await screen.findByText(/board/i)).toBeInTheDocument()
  })

  it('routes Analytics as a normal page rather than a drawer', async () => {
    render(<AppShell locationHook={at('/analytics')} />)
    expect(await screen.findByRole('heading', { name: /^analytics$/i })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /analytics/i })).toBeNull()
  })

  it('sends unknown routes home to the Research desk', async () => {
    render(<AppShell locationHook={at('/no-such-page')} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Research desk' })).toBeInTheDocument()
  })
})
