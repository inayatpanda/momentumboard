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
  it('opens on Today at /app/', async () => {
    render(<AppShell locationHook={at('/')} />)
    expect(await screen.findByRole('heading', { name: /today/i })).toBeInTheDocument()
  })

  it('shows exactly the five ratified nav labels, in order — Board is routable but unlabelled', () => {
    render(<AppShell locationHook={at('/')} />)
    const nav = screen.getByRole('navigation')
    const labels = [...nav.querySelectorAll('.v2-tab-label')].map(el => el.textContent?.trim())
    expect(labels).toEqual(['Today', 'Stocks', 'Intel', 'Track record', 'More'])
  })

  it('deep-links a stock page with its symbol', async () => {
    render(<AppShell locationHook={at('/stock/NVDA')} />)
    expect(await screen.findByText(/NVDA/)).toBeInTheDocument()
  })

  it('routes /board even though it has no tab', async () => {
    render(<AppShell locationHook={at('/board')} />)
    expect(await screen.findByText(/board/i)).toBeInTheDocument()
  })

  it('sends unknown routes home to Today', async () => {
    render(<AppShell locationHook={at('/no-such-page')} />)
    expect(await screen.findByRole('heading', { name: /today/i })).toBeInTheDocument()
  })
})
