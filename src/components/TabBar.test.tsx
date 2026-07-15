import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TabBar } from './TabBar'

// The desktop rail (≥1024px shows .tab.sec rows) must carry EVERY destination:
// More is hidden there, so anything missing from TABS has no desktop entrance.
describe('TabBar', () => {
  it('carries Ledger and Settings as rail rows', () => {
    render(<TabBar active="watchlist" onNavigate={() => {}} />)
    expect(screen.getByText('Ledger')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    // and they are desktop-rail rows, not new mobile tabs
    expect(screen.getByText('Ledger').closest('button')!.className).toContain('sec')
    expect(screen.getByText('Settings').closest('button')!.className).toContain('sec')
  })

  it('lights the Settings row when settings is active', () => {
    render(<TabBar active="settings" onNavigate={() => {}} />)
    expect(screen.getByText('Settings').closest('button')!.className).toContain('active')
  })
})
